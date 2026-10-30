//! Path candidate extraction and normalisation.
//!
//! Everything here works on decoded strings (JSON escapes already resolved), so
//! a Windows path in the source text appears with single backslashes.

/// Characters that terminate a path candidate when scanning free text.
///
/// A space is *not* here: `C:\Program Files\nodejs\node.exe` is a real path.
/// Spans with spaces are cut afterwards, at points where a new path starts.
fn is_path_byte(b: u8) -> bool {
    !matches!(
        b,
        b'\t' | b'\r'
            | b'\n'
            | b'"'
            | b'\''
            | b'`'
            | b'*'
            | b'<'
            | b'>'
            | b'|'
            | b','
            | b';'
            | b')'
            | b']'
            | b'}'
            | b'('
            | b'['
    )
}

fn is_boundary(b: &[u8], i: usize) -> bool {
    if i == 0 {
        return true;
    }
    let p = b[i - 1];
    !(p.is_ascii_alphanumeric() || p == b':' || p == b'\\' || p == b'/' || p == b'_' || p == b'.')
}

/// Trailing characters that are almost always punctuation around a path, not
/// part of it (markdown emphasis, quoting, sentence punctuation, a dangling
/// sentence stop).
fn is_trailing_junk(c: char) -> bool {
    matches!(
        c,
        '`' | '"'
            | '\''
            | '*'
            | '_'
            | ')'
            | ']'
            | '>'
            | ','
            | ';'
            | ':'
            | '.'
            | '。'
            | '，'
            | '、'
            | '；'
            | '：'
            | '！'
            | '？'
            | '\\'
            | '/'
    )
}

/// Last path segment, i.e. everything after the final separator.
fn last_segment(s: &str) -> &str {
    match s.rfind(['\\', '/']) {
        Some(i) => &s[i + 1..],
        None => s,
    }
}

/// Does the final segment look like `name.ext`?
///
/// A leading dot (`.gitignore`) still counts; the point is that the candidate
/// names a file, not a folder, which is what filters prose noise.
fn has_extension(s: &str) -> bool {
    let seg = last_segment(s);
    match seg.rfind('.') {
        Some(pos) if pos + 1 < seg.len() => {
            let ext = &seg[pos + 1..];
            (1..=12).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphanumeric())
        }
        // `.gitignore`: dot at index 0 with a body but no further dot.
        Some(0) => seg.len() > 1 && seg[1..].chars().all(|c| c.is_ascii_alphanumeric()),
        _ => false,
    }
}

/// End of the path at the start of `span`, i.e. the first extension followed by
/// something that cannot continue a file name.
///
/// This is what separates `D:\a\b.md，見 a.b` from `D:\a\v1.0`: the second ends
/// in a dot segment, so only an extension *surrounded by* a boundary counts.
fn path_end(span: &str) -> usize {
    let b = span.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        if b[i] == b'.' {
            let mut e = i + 1;
            while e < b.len() && b[e].is_ascii_alphanumeric() {
                e += 1;
            }
            let ext_len = e - i - 1;
            let next_ok = e == b.len() || !(b[e].is_ascii_alphanumeric() || b[e] == b'.' || b[e] == b'-' || b[e] == b'_');
            if (1..=12).contains(&ext_len) && next_ok && has_extension(&span[..e]) {
                return e;
            }
            i = e;
            continue;
        }
        i += 1;
    }
    span.len()
}

/// Trim a raw run down to the path itself.
///
/// Used on the head produced by [`path_end`]; it also cleans trailing
/// punctuation that survived because the path had no extension at all.
fn trim_tail(s: &str) -> &str {
    let mut end = s.len();
    while end > 3 {
        let mut e = end;
        loop {
            match s[..e].chars().next_back() {
                Some(c) if is_trailing_junk(c) => e -= c.len_utf8(),
                _ => break,
            }
        }
        // Keep `v1.0`-style tails, but drop a sentence-final `.` after a real
        // extension (`a.md.`).
        if e > 3 && s[..e].ends_with('.') && has_extension(&s[..e - 1]) {
            e -= 1;
        }
        if e <= 3 || has_extension(&s[..e]) {
            return &s[..e];
        }
        end = e - s[..e].chars().next_back().map_or(1, char::len_utf8);
    }
    &s[..end]
}

/// Canonical spelling of a path: `/` -> `\`, repeated separators collapsed,
/// drive letter upper-cased, `.`/`..` segments resolved, trailing separator
/// dropped. Pure lexical — it never touches the disk.
///
/// The `..` resolution is lexical because a transcript can name a file that no
/// longer exists; resolving through the filesystem would fail there and hand
/// back a path that does not match its own duplicates.
pub fn normalize(raw: &str) -> String {
    // `\\?\C:\...` keeps both its leading backslashes and the `?`.
    let extended = raw.starts_with("\\\\?\\");
    let (unc, body) = if let Some(rest) = raw.strip_prefix("\\\\?\\") {
        (true, rest)
    } else if let Some(rest) = raw.strip_prefix("\\\\").or_else(|| raw.strip_prefix("//")) {
        (true, rest)
    } else {
        (false, raw)
    };

    let mut out = String::with_capacity(raw.len());
    if unc {
        out.push_str("\\\\");
        if extended {
            out.push_str("?\\");
        }
    }

    // A drive prefix (`d:`) is not a `..`-pop target and is upper-cased so
    // `d:\x` and `D:\x` collapse to one key.
    let mut prefix: Option<String> = None;
    let mut rest = body.trim_start_matches(['\\', '/']);
    if !unc {
        match rest.split_once(['\\', '/']) {
            Some((head, tail)) if is_drive(head) => {
                prefix = Some(head.to_uppercase());
                rest = tail;
            }
            _ if is_drive(rest) => {
                prefix = Some(rest.to_uppercase());
                rest = "";
            }
            _ => {}
        }
    }

    let mut segments: Vec<&str> = Vec::new();
    for seg in rest.split(['\\', '/']) {
        match seg {
            "" | "." => {}
            ".." => match segments.pop() {
                Some(_) => {}
                // `D:\..\x` is `D:\x`; a share root keeps the `..`.
                None => {
                    if prefix.is_none() && !unc {
                        segments.push("..");
                    }
                }
            },
            s => segments.push(s),
        }
    }

    if let Some(p) = prefix {
        out.push_str(&p);
        if !segments.is_empty() {
            out.push('\\');
        }
    }

    out.push_str(&segments.join("\\"));
    out
}

fn is_drive(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 2 && b[0].is_ascii_alphabetic() && b[1] == b':'
}

/// True for `D:\x`, `\\server\share` and `\\?\C:\x` style absolute paths.
pub fn is_absolute_windows(path: &str) -> bool {
    let b = path.as_bytes();
    if b.len() >= 3
        && b[0].is_ascii_alphabetic()
        && b[1] == b':'
        && (b[2] == b'\\' || b[2] == b'/')
    {
        return true;
    }
    b.len() >= 3 && (b[0] == b'\\' || b[0] == b'/') && (b[1] == b'\\' || b[1] == b'/')
}

/// Does a drive (`D:\`) or UNC prefix start at `i`?
fn path_start(b: &[u8], i: usize) -> Option<usize> {
    if i + 2 < b.len()
        && b[i].is_ascii_alphabetic()
        && b[i + 1] == b':'
        && (b[i + 2] == b'\\' || b[i + 2] == b'/')
    {
        return Some(i + 3);
    }
    if i + 1 < b.len() && (b[i] == b'\\' || b[i] == b'/') && (b[i + 1] == b'\\' || b[i + 1] == b'/') {
        // `\\?\C:\...` and `\\srv\share\...` both continue right after.
        return Some(i + 2);
    }
    None
}

/// Reject `\\` hits that are really prose.
///
/// A lone `\\` is also markdown's line-break and a common "continued on next
/// line" marker, so `\\ receipt-format.ts` or `\\ 從 .env` slip through the
/// shape check. A real UNC path always names a server *and* a share.
fn is_plausible_unc(norm: &str) -> bool {
    if !norm.starts_with("\\\\") {
        return true;
    }
    // `\\?\C:\...` carries a drive letter, so it is already unambiguous.
    if norm.starts_with("\\\\?\\") {
        return true;
    }
    let mut parts = norm.trim_start_matches("\\\\").split('\\');
    let (Some(server), Some(share)) = (parts.next(), parts.next()) else {
        return false;
    };
    let ok = |s: &str| !s.is_empty() && !s.contains(' ') && s.chars().any(|c| c.is_ascii_alphanumeric());
    ok(server) && ok(share)
}

/// Pull absolute Windows paths out of prose. Returns normalised paths carrying
/// an extension, deduplicated within the text.
///
/// Candidates must end in an extension: prose is full of `D:\folder\` style
/// drive references that name folders, not files.
pub fn extract_paths(text: &str) -> Vec<String> {
    let b = text.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut i = 0usize;
    while i < b.len() {
        // `file:///D:/x` prefixes paths with a separator.
        let mut start = i;
        if start + 2 < b.len()
            && (b[start] == b'/' || b[start] == b'\\')
            && b[start + 1].is_ascii_alphabetic()
            && b[start + 2] == b':'
        {
            start += 1;
        }
        let Some(after_scheme) = path_start(b, start) else {
            i += 1;
            continue;
        };
        // A shifted start is already delimited by the separator we skipped.
        if start == i && !is_boundary(b, i) {
            i += 1;
            continue;
        }
        let mut j = after_scheme;
        while j < b.len() && is_path_byte(b[j]) {
            // `\\?\C:` — the `?` belongs to the prefix, not the path body.
            if b[j] == b'?' && j == after_scheme && is_absolute_windows(&text[start..j + 1]) {
                j += 1;
                continue;
            }
            j += 1;
        }
        // A span may contain spaces, so cut it wherever a new path starts and
        // keep only the head (the part belonging to this candidate).
        let span = &text[start..j];
        let cut = next_path_offset(span, start == i && b[start].is_ascii_alphabetic());
        let head = &span[..cut];
        let raw = trim_tail(&head[..path_end(head)]);
        if is_absolute_windows(raw) {
            let norm = normalize(raw);
            if norm.len() > 3 && has_extension(&norm) && is_plausible_unc(&norm) && seen.insert(norm.to_lowercase()) {
                out.push(norm);
            }
        }
        // Resume at the cut, not at `j`: the span may hold several paths and
        // the next one must still be scanned.
        i = (start + cut).max(i + 1);
    }
    out
}

/// Byte offset where a following path starts inside `span` (0 if none).
fn next_path_offset(span: &str, drive_start: bool) -> usize {
    let b = span.as_bytes();
    let from = if drive_start { 3 } else { 2 };
    for i in from..b.len() {
        if b[i] == b' ' && path_start(b, i + 1).is_some() {
            return i;
        }
    }
    span.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_separators_and_dupes() {
        assert_eq!(normalize(r"D:/a//b\\c.md"), r"D:\a\b\c.md");
        assert_eq!(normalize(r"\\srv/share\x.md"), r"\\srv\share\x.md");
    }

    #[test]
    fn extracts_plain_and_markdown_wrapped() {
        let t = "寫進 D:\\workspace\\p\\REPORT.md 了，另外看 `D:/x/y.py`。";
        let got = extract_paths(t);
        assert_eq!(
            got,
            vec![r"D:\workspace\p\REPORT.md".to_string(), r"D:\x\y.py".to_string()]
        );
    }

    #[test]
    fn trims_sentence_punctuation_keeps_version_tail() {
        assert_eq!(extract_paths("見 D:\\a\\b.md."), vec![r"D:\a\b.md".to_string()]);
        assert_eq!(extract_paths("(D:\\a\\b.md)"), vec![r"D:\a\b.md".to_string()]);
        assert_eq!(extract_paths("在 D:\\a\\v1.0"), vec![r"D:\a\v1.0".to_string()]);
    }

    #[test]
    fn stops_before_trailing_prose() {
        // A CJK sentence continues straight after the path with no delimiter.
        assert_eq!(
            extract_paths("改好 D:\\a\\b.md，見 a.b 那節"),
            vec![r"D:\a\b.md".to_string()]
        );
    }

    #[test]
    fn handles_chinese_paths_and_unc() {
        let got = extract_paths("存到 D:\\工作\\報告\\測試檔案.md 與 \\\\nas\\share\\x.txt");
        assert_eq!(
            got,
            vec![r"D:\工作\報告\測試檔案.md".to_string(), r"\\nas\share\x.txt".to_string()]
        );
    }

    #[test]
    fn keeps_paths_with_spaces() {
        assert_eq!(
            extract_paths("跑 C:\\Program Files\\nodejs\\node.exe 就好"),
            vec![r"C:\Program Files\nodejs\node.exe".to_string()]
        );
    }

    #[test]
    fn handles_extended_length_prefix() {
        assert_eq!(
            extract_paths("讀 \\\\?\\C:\\long\\a.txt"),
            vec![r"\\?\C:\long\a.txt".to_string()]
        );
    }

    #[test]
    fn accepts_dotfiles_and_forward_slash_unc() {
        assert_eq!(extract_paths("看 D:\\proj\\.gitignore"), vec![r"D:\proj\.gitignore".to_string()]);
        assert_eq!(extract_paths("//nas/share/x.txt"), vec![r"\\nas\share\x.txt".to_string()]);
    }

    #[test]
    fn ignores_relative_drive_less_text() {
        assert!(extract_paths("src/lib.rs 與 tools/a.py 都不算").is_empty());
        assert!(extract_paths("C: 只是磁碟").is_empty());
    }

    #[test]
    fn does_not_split_on_drive_inside_word() {
        assert!(extract_paths("abcD:\\x\\y.md").is_empty());
        assert_eq!(extract_paths("x=D:\\x\\y.md"), vec![r"D:\x\y.md".to_string()]);
    }

    #[test]
    fn drive_letter_is_upper_cased_for_dedupe() {
        assert_eq!(normalize(r"d:\a\b.md"), r"D:\a\b.md");
    }

    #[test]
    fn resolves_dot_segments_lexically() {
        assert_eq!(normalize(r"D:\a\.\b\..\c.md"), r"D:\a\c.md");
        assert_eq!(normalize(r"D:\..\x.md"), r"D:\x.md");
        assert_eq!(normalize(r"\\srv\share\a\..\b.md"), r"\\srv\share\b.md");
    }

    #[test]
    fn drops_trailing_separator_but_keeps_unc_prefix() {
        assert_eq!(normalize(r"D:\a\b\"), r"D:\a\b");
        assert_eq!(normalize(r"\\srv\share\"), r"\\srv\share");
        assert_eq!(normalize(r"D:\"), r"D:");
    }

    #[test]
    fn accepts_file_url_prefix() {
        assert_eq!(extract_paths("file:///D:/x/y.md"), vec![r"D:\x\y.md".to_string()]);
    }

    #[test]
    fn dedupes_within_one_text() {
        assert_eq!(
            extract_paths("D:\\a\\b.md 和 D:/a/b.md 和 `D:\\a\\b.md`"),
            vec![r"D:\a\b.md".to_string()]
        );
    }
}
