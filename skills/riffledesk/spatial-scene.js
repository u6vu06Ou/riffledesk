import * as THREE from 'three';
import {OrbitControls} from './OrbitControls.js';
const box=document.querySelector('#viewport'), status=document.querySelector('#status');
try {
 const scene=new THREE.Scene();scene.background=new THREE.Color('#20373c');
 const camera=new THREE.PerspectiveCamera(38,1,.1,100);camera.position.set(7,6,8);
 const renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,1.75));renderer.outputColorSpace=THREE.SRGBColorSpace;box.appendChild(renderer.domElement);
 const controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.target.set(0,1,0);controls.minDistance=5;controls.maxDistance=20;controls.saveState();
 scene.add(new THREE.HemisphereLight(0xfff5df,0x355167,2.6));const light=new THREE.DirectionalLight(0xfff1d0,3.2);light.position.set(4,8,5);scene.add(light);
 const group=new THREE.Group();scene.add(group);const pickable=[];
 function layer(name,y,color,sx,sy,sz){const g=new THREE.Group();g.position.y=y;g.userData.base=y;g.userData.name=name;const m=new THREE.Mesh(new THREE.BoxGeometry(sx,sy,sz),new THREE.MeshStandardMaterial({color,roughness:.48,metalness:.17}));m.userData.name=name;g.add(m);group.add(g);pickable.push(m);return g}
 const base=layer('底座',.35,0x697d87,3.9,.45,2.7),board=layer('電路板',.82,0x73a891,3.35,.16,2.2),cover=layer('上蓋',1.23,0xd29d63,3.9,.35,2.7);
 for(let i=0;i<3;i++){const chip=new THREE.Mesh(new THREE.BoxGeometry(.45,.17,.5),new THREE.MeshStandardMaterial({color:0x293d40}));chip.position.set(-.9+i*.85,.16,0);chip.userData.name='電路板上的示意元件';board.add(chip);pickable.push(chip)}
 const grid=new THREE.GridHelper(16,32,0x6f9386,0x385454);scene.add(grid);
 const ray=new THREE.Raycaster(),mouse=new THREE.Vector2();let down;
 renderer.domElement.addEventListener('pointerdown',e=>down=[e.clientX,e.clientY]);renderer.domElement.addEventListener('pointerup',e=>{if(!down||Math.hypot(e.clientX-down[0],e.clientY-down[1])>5)return;const r=renderer.domElement.getBoundingClientRect();mouse.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);ray.setFromCamera(mouse,camera);const hit=ray.intersectObjects(pickable)[0];document.querySelector('#selection').textContent=hit?'選到：'+hit.object.userData.name:'這裡是背景；請點選零件。'});
 const slider=document.querySelector('#explode');slider.addEventListener('input',()=>{const k=+slider.value/100;board.position.y=board.userData.base+k*1.15;cover.position.y=cover.userData.base+k*2.3;document.querySelector('#explodeOut').textContent=slider.value+'%';document.body.dataset.explode=slider.value;});
 const rotation=document.querySelector('#rotation');rotation.onclick=()=>{controls.autoRotate=!controls.autoRotate;rotation.textContent=controls.autoRotate?'停止自動旋轉':'開始自動旋轉';rotation.setAttribute('aria-pressed',controls.autoRotate)};
 document.querySelector('#reset').onclick=()=>{controls.reset();controls.autoRotate=false;rotation.textContent='開始自動旋轉';rotation.setAttribute('aria-pressed','false');slider.value='0';slider.dispatchEvent(new Event('input'));};
 function resize(){const w=box.clientWidth,h=box.clientHeight;if(!w||!h)return;camera.aspect=w/h;camera.updateProjectionMatrix();renderer.setSize(w,h,false)}const observer=new ResizeObserver(resize);observer.observe(box);resize();
 let visible=true;const io=new IntersectionObserver(es=>visible=es[0].isIntersecting);io.observe(box);let raf;function draw(){raf=requestAnimationFrame(draw);if(document.hidden||!visible)return;controls.update();renderer.render(scene,camera)}draw();
 renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();document.querySelector('#fallback').hidden=false;document.querySelector('#fallbackMessage').textContent='3D 畫面暫時中斷；重新開啟此檔可再試。';status.textContent='已切換靜態示意';});
 window.addEventListener('pagehide',()=>{cancelAnimationFrame(raf);observer.disconnect();io.disconnect();controls.dispose();scene.traverse(o=>{o.geometry?.dispose();if(o.material)(Array.isArray(o.material)?o.material:[o.material]).forEach(m=>m.dispose())});renderer.dispose();},{once:true});
 document.querySelector('#fallback').hidden=true;status.textContent='3D 已載入 · 本地資源';document.body.dataset.ready='true';
}catch(err){status.textContent='無法啟用 3D，保留靜態示意';document.querySelector('#fallbackMessage').textContent='這台裝置暫時無法顯示 3D。上方保留三層結構示意，可繼續閱讀。';console.error(err);}
