# Delivery capabilities

RiffleDesk reads ordinary Markdown with book-like spacing and bounded line
length. The original file stays unchanged. Use Markdown for normal documents.
Choose HTML when interaction or a particular visual layout adds value; do not
convert every report or force a template.

One HTML document can contain readable paragraphs, images, SVG diagrams,
tables, interactive controls, and a three.js figure between two paragraphs.
Keep prose and captions in the DOM, not inside a canvas. Use images or SVG for
ordinary illustrations; use 3D for spatial relationships, assemblies or motion.
`.js` is source code, not a standalone 3D deliverable. Deliver an HTML entry point.
This does not provide a native STEP/STP or proprietary CAE engine.

## Interactive HTML delivery

- Open the HTML entry point through `riffledesk open`. The user chooses **Run
  page code**; do not bypass this choice. Static preview never executes scripts.
- Include meaningful static text and an image/SVG fallback before scripts run.
  Keep it visible when imports or WebGL fail, with a readable failure message.
- Deliver the complete folder with relative paths. Keep images, models, scripts
  and pinned, matching three.js/addon versions together. Local assets work
  without an external CDN; RiffleDesk's own interface may still need a network.
- Built HTML is supported. RiffleDesk does not run a project's npm development
  server or execute an arbitrary `.js` file as a page.
- Resize the figure to its container. Scope pointer/wheel controls to the figure;
  leave the rest of the document scrollable. Provide reset and visible controls.
- Pause rendering when hidden or outside the visible area. Dispose animation,
  observers and GPU resources on page exit. Closing the reader removes running
  frames. Reopening creates a fresh page.
- Keep static output useful for printing and devices without WebGL. Do not imply
  engineering accuracy for illustrative geometry.
- Mark editable DOM regions with stable `data-rd-id` values for revamp feedback.

## Optional starting points

These are references, not required formats. Copy assets to the delivery folder
and adapt them to the user's content; do not link into an installed skill path.

- [Illustrated steps](illustrated-report.html): text plus an SVG diagram and
  step controls. One HTML file, no runtime dependencies.
- [Document with a spatial figure](spatial-report.html): text before and after
  an interactive assembly. Copy this HTML plus `spatial-scene.js`,
  `three.module.min.js`, `OrbitControls.js` and `three.LICENSE` together.
  These examples use three.js 0.160.0 and matching OrbitControls under MIT.

Pick a simpler output if 3D does not make the explanation clearer. The examples
do not create a requirement to install a new skill or change the agent's usual
delivery format.
