import {useEffect,useRef} from 'react';
import * as T from 'three';
import {OrbitControls} from 'three/examples/jsm/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {mergeGeometries} from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {createExplosionLayout} from './explosion-layout';
import {decodeModelResponse} from './model-download';
import {PointerTap} from './pointer-tap';
import {SYSTEMS,type Atlas,type SceneState} from './anatomy';

interface Props {
 atlas:Atlas;
 state:SceneState;
 onSelect:(id:string)=>void;
 onDissect:(id:string)=>void;
 onDisplace:(id:string,delta:[number,number,number])=>void;
 onPlaceRetractor:(point:[number,number,number],normal:[number,number,number])=>void;
 onProgress:(n:number)=>void;
 onError:(s:string)=>void;
}

const isSuperficialSystem=(system:string,cutBone:boolean)=>
 system==='integumentary'||system==='muscular'||system==='connective'||(cutBone&&system==='skeletal');

export default function AnatomyScene({atlas,state,onSelect,onDissect,onDisplace,onPlaceRetractor,onProgress,onError}:Props){
 const host=useRef<HTMLDivElement>(null),latest=useRef(state),select=useRef(onSelect),dissect=useRef(onDissect),displace=useRef(onDisplace),placeRetractor=useRef(onPlaceRetractor);
 latest.current=state;select.current=onSelect;dissect.current=onDissect;displace.current=onDisplace;placeRetractor.current=onPlaceRetractor;

 useEffect(()=>{
  const el=host.current!;let disposed=false,frame=0,dirty=true,ready=false,lastView='',lastReset=-1,lastIsolate='',layoutKey='',amount=0;
  let lastState:SceneState|null=null;
  const abort=new AbortController();
  let renderer:T.WebGLRenderer;
  try{renderer=new T.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});}catch{onError('This browser could not start the 3D viewer. Please try a browser with WebGL enabled.');return;}
  renderer.setPixelRatio(Math.min(devicePixelRatio,innerWidth<768?1.5:2));renderer.setClearColor('#f2f3f3');renderer.outputColorSpace=T.SRGBColorSpace;renderer.toneMapping=T.ACESFilmicToneMapping;renderer.toneMappingExposure=1.12;
  renderer.localClippingEnabled=true;
  el.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label','Interactive human anatomy. Drag to orbit, pinch or scroll to zoom, and tap a structure to inspect it.');

  const scene=new T.Scene(),camera=new T.PerspectiveCamera(34,1,.005,100),controls=new OrbitControls(camera,renderer.domElement);
  camera.position.set(1.4,1.05,3.6);controls.target.set(0,.85,0);controls.enableDamping=true;controls.dampingFactor=.085;controls.minDistance=.07;controls.maxDistance=40;controls.maxPolarAngle=Math.PI*.96;controls.addEventListener('change',()=>{dirty=true;});
  const pmrem=new T.PMREMGenerator(renderer),room=new RoomEnvironment(),env=pmrem.fromScene(room,.04);scene.environment=env.texture;room.dispose();pmrem.dispose();
  scene.add(new T.HemisphereLight(0xffffff,0xa7acb2,1.05));
  const key=new T.DirectionalLight(0xfffaf4,2.3);key.position.set(-2,4,3);scene.add(key);
  const rim=new T.DirectionalLight(0xe9f0ff,1.8);rim.position.set(2,2,-3);scene.add(rim);
  const ground=new T.Mesh(new T.CircleGeometry(30,96),new T.MeshStandardMaterial({color:0xd5d9dc,roughness:1}));ground.rotation.x=-Math.PI/2;ground.position.y=-.019;scene.add(ground);
  const platform=new T.Mesh(new T.CylinderGeometry(.68,.7,.028,100),new T.MeshStandardMaterial({color:0xeeeeec,metalness:.12,roughness:.67}));platform.position.y=-.016;scene.add(platform);
  const ring=new T.Mesh(new T.RingGeometry(.63,.632,128),new T.MeshBasicMaterial({color:0x8c969f,transparent:true,opacity:.4,side:T.DoubleSide}));ring.rotation.x=-Math.PI/2;ring.position.y=.001;scene.add(ring);
  const innerRing=new T.Mesh(new T.RingGeometry(.55,.551,128),new T.MeshBasicMaterial({color:0xa4aeb8,transparent:true,opacity:.16,side:T.DoubleSide}));innerRing.rotation.x=-Math.PI/2;innerRing.position.y=.001;scene.add(innerRing);

  // 3D Surgical Retractor Ring indicator
  const retractorGeo=new T.TorusGeometry(1,.018,16,64);
  const retractorMat=new T.MeshStandardMaterial({color:0x38bdf8,emissive:0x0284c7,emissiveIntensity:.35,metalness:.65,roughness:.25,transparent:true,opacity:.85,depthTest:false});
  const retractorRing=new T.Mesh(retractorGeo,retractorMat);
  retractorRing.visible=false;
  retractorRing.renderOrder=15;
  scene.add(retractorRing);

  // Cross-section clipping plane + visual helper plane
  const clipPlane=new T.Plane(new T.Vector3(0,-1,0),1.2);
  const sliceHelperGeo=new T.RingGeometry(.38,.385,64);
  const sliceHelperMat=new T.MeshBasicMaterial({color:0x0ea5e9,transparent:true,opacity:.55,side:T.DoubleSide,depthTest:false});
  const sliceHelper=new T.Mesh(sliceHelperGeo,sliceHelperMat);
  sliceHelper.visible=false;
  sliceHelper.renderOrder=14;
  scene.add(sliceHelper);

  const width=T.MathUtils.ceilPowerOfTwo(atlas.parts.length),data=new Float32Array(width*4),partTexture=new T.DataTexture(data,width,1,T.RGBAFormat,T.FloatType);partTexture.needsUpdate=true;
  const selectedData=new Uint8Array(width*4),selectionTexture=new T.DataTexture(selectedData,width,1);selectionTexture.needsUpdate=true;
  const materials:T.Material[]=[],geometries:T.BufferGeometry[]=[],pickers:(T.Mesh|undefined)[]=[],centers=atlas.parts.map(p=>new T.Vector3().fromArray(p.bounds[0]).add(new T.Vector3().fromArray(p.bounds[1])).multiplyScalar(.5));
  const offsets:T.Vector3[]=[],bounds=atlas.parts.map(p=>new T.Box3(new T.Vector3().fromArray(p.bounds[0]),new T.Vector3().fromArray(p.bounds[1])));
  let packingWidth=1,packingHeight=1;
  const markerPositions=new Float32Array(atlas.parts.length*3),markerGeometry=new T.BufferGeometry();markerGeometry.setAttribute('position',new T.BufferAttribute(markerPositions,3));
  const markerMaterial=new T.PointsMaterial({color:0x64748b,size:5,sizeAttenuation:false,transparent:true,opacity:.72,depthTest:false});
  markerMaterial.onBeforeCompile=shader=>{shader.fragmentShader=shader.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\nif (distance(gl_PointCoord, vec2(0.5)) > 0.5) discard;');};
  const markers=new T.Points(markerGeometry,markerMaterial);markers.frustumCulled=false;markers.renderOrder=10;markers.visible=false;scene.add(markers);
  const hover=document.createElement('div');hover.className='part-hover';hover.setAttribute('role','tooltip');hover.hidden=true;el.appendChild(hover);
  type Target={index:number;x:number;y:number;left:number;right:number;top:number;bottom:number};let targets:Target[]=[];
  const projected=new T.Vector3();
  const findTarget=(x:number,y:number,radius:number)=>{
   let best=-1,score=Infinity;
   for(const t of targets){const dx=Math.max(t.left-x,0,x-t.right),dy=Math.max(t.top-y,0,y-t.bottom),distance=Math.hypot(dx,dy);if(distance>radius)continue;const candidate=distance+Math.hypot(t.x-x,t.y-y)*.025;if(candidate<score){score=candidate;best=t.index;}}
   return best;
  };

  const retractorUniforms=new Map<string,{pos:{value:T.Vector3};radius:{value:number}}>();

  const materialFor=(system:string)=>{
   const rUniform={pos:{value:new T.Vector3(0,100,0)},radius:{value:0}};
   retractorUniforms.set(system,rUniform);
   const m=new T.MeshStandardMaterial({color:SYSTEMS.find(s=>s.id===system)?.color??'#aebbb8',metalness:.08,roughness:.53,side:T.DoubleSide,transparent:system==='integumentary',opacity:system==='integumentary'?.14:1,depthWrite:system!=='integumentary'});
   m.onBeforeCompile=shader=>{
    shader.uniforms.partState={value:partTexture};
    shader.uniforms.selectionState={value:selectionTexture};
    shader.uniforms.stateWidth={value:width};
    shader.uniforms.retractorPos=rUniform.pos;
    shader.uniforms.retractorRadius=rUniform.radius;
    shader.vertexShader='attribute float partIndex; uniform sampler2D partState; uniform sampler2D selectionState; uniform float stateWidth; uniform vec3 retractorPos; uniform float retractorRadius; varying float partVisible; varying float partSelected; varying vec3 vSurgPos;\n'+shader.vertexShader;
    shader.vertexShader=shader.vertexShader.replace(
     '#include <begin_vertex>',
     `#include <begin_vertex>
vec2 stateUv = vec2((partIndex + 0.5) / stateWidth, 0.5);
vec4 state = texture2D(partState, stateUv);
transformed += state.xyz;
vSurgPos = transformed;
if (retractorRadius > 0.001) {
 float rDist = distance(transformed, retractorPos);
 if (rDist < retractorRadius * 1.32 && rDist >= retractorRadius * 0.85) {
  vec3 pushDir = normalize(transformed - retractorPos + vec3(0.0, 0.0, 0.0001));
  float rimFactor = 1.0 - abs(rDist - retractorRadius) / (retractorRadius * 0.45);
  transformed += pushDir * max(0.0, rimFactor) * 0.016;
 }
}
partVisible = state.w;
partSelected = texture2D(selectionState, stateUv).r;`
    );
    shader.fragmentShader='uniform vec3 retractorPos; uniform float retractorRadius; varying float partVisible; varying float partSelected; varying vec3 vSurgPos;\n'+shader.fragmentShader;
    shader.fragmentShader=shader.fragmentShader.replace(
     '#include <clipping_planes_fragment>',
     `#include <clipping_planes_fragment>
if (partVisible < 0.5) discard;
if (retractorRadius > 0.001) {
 float rDist = distance(vSurgPos, retractorPos);
 if (rDist < retractorRadius) discard;
}`
    );
    shader.fragmentShader=shader.fragmentShader.replace(
     '#include <color_fragment>',
     `#include <color_fragment>
if (retractorRadius > 0.001) {
 float rDist = distance(vSurgPos, retractorPos);
 if (rDist < retractorRadius + 0.011) {
  float edgeT = clamp((rDist - retractorRadius) / 0.011, 0.0, 1.0);
  diffuseColor.rgb = mix(vec3(0.76, 0.16, 0.18), diffuseColor.rgb, edgeT);
 }
}
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.85, 0.78), partSelected * 0.75);`
    );
   };
   materials.push(m);
   return m;
  };

  const mats=new Map(SYSTEMS.map(s=>[s.id,materialFor(s.id)]));
  let loaded=0;
  const loadChunk=async(ci:number)=>{
   const chunk=atlas.chunks[ci],compressed=!!chunk.gzip&&typeof DecompressionStream!=='undefined',rawUrl=compressed?chunk.gzip!:chunk.url,chunkUrl=rawUrl.startsWith('/')?`.${rawUrl}`:rawUrl;const response=await fetch(chunkUrl,{signal:abort.signal});const buffer=await decodeModelResponse(response,chunk.bytes,compressed);if(disposed)return;
   const groups=new Map<string,T.BufferGeometry[]>();
   atlas.parts.forEach((p,i)=>{
    if(p.chunk!==ci)return;
    const g=new T.BufferGeometry();g.setAttribute('position',new T.BufferAttribute(new Float32Array(buffer,p.positions,p.vertexCount*3),3));
    g.setAttribute('normal',new T.BufferAttribute(new Int16Array(buffer,p.normals,p.vertexCount*3),3,true));g.setIndex(new T.BufferAttribute(new Uint32Array(buffer,p.indices,p.indexCount),1));
    g.boundingBox=bounds[i].clone();g.computeBoundingSphere();const pick=new T.Mesh(g);pick.matrixAutoUpdate=false;pickers[i]=pick;geometries.push(g);
    g.setAttribute('partIndex',new T.BufferAttribute(new Float32Array(p.vertexCount).fill(i),1));
    const list=groups.get(p.system)??[];list.push(g);groups.set(p.system,list);
   });
   groups.forEach((gs,system)=>{const geometry=mergeGeometries(gs,false);if(!geometry)throw new Error('Could not assemble anatomy geometry.');geometries.push(geometry);const mesh=new T.Mesh(geometry,mats.get(system as never));mesh.frustumCulled=false;scene.add(mesh);});
   lastState=null;loaded++;onProgress(Math.round(loaded/atlas.chunks.length*100));dirty=true;
  };
  (async()=>{try{let cursor=0;await Promise.all(Array.from({length:3},async()=>{while(cursor<atlas.chunks.length){const i=cursor++;await loadChunk(i);}}));if(!disposed){ready=true;dirty=true;}}catch(e){if(!disposed)onError(e instanceof Error?e.message:'Could not load the anatomy.');}})();

  const fit=(view:string,extent=0)=>{
   const mobile=el.clientWidth<768,normalDistance=mobile?Math.max(4.5,1.8*el.clientHeight/Math.max(160,el.clientHeight-350)/(2*Math.tan(T.MathUtils.degToRad(camera.fov/2)))):4;
   const reservedHeight=mobile?350:270;const availableAspect=Math.max(.35,(el.clientWidth-(mobile?40:340))/Math.max(160,el.clientHeight-reservedHeight));const atlasDistance=Math.max(packingHeight,packingWidth/availableAspect)/(2*Math.tan(T.MathUtils.degToRad(camera.fov/2)))*(el.clientHeight/Math.max(160,el.clientHeight-reservedHeight))*1.08;
   const distance=T.MathUtils.lerp(normalDistance,Math.max(.2,atlasDistance),extent);if(extent>.8)view='front';
   const direction=view==='front'?new T.Vector3(0,.02,1):view==='back'?new T.Vector3(0,.02,-1):view==='side'?new T.Vector3(1,.02,0):new T.Vector3(.35,.06,1).normalize();
   controls.target.set(extent>.1&&el.clientWidth>767?-packingWidth*.12:0,extent>.1||mobile?.85:.68,0);camera.position.copy(controls.target).addScaledVector(direction,distance);controls.update();dirty=true;
  };
  const resize=()=>{layoutKey='';lastState=null;renderer.setPixelRatio(Math.min(devicePixelRatio,el.clientWidth<768||el.clientHeight<600?1.5:2));camera.aspect=el.clientWidth/el.clientHeight;camera.updateProjectionMatrix();renderer.setSize(el.clientWidth,el.clientHeight);fit(latest.current.view,amount);};const observer=new ResizeObserver(resize);observer.observe(el);

  const raycaster=new T.Raycaster(),pointer=new T.Vector2(),tap=new PointerTap(),worldBox=new T.Box3(),hitPoint=new T.Vector3();
  const retractorVec=new T.Vector3();

  // Raycast helper that respects active Surgical Retractor window & Slicer plane
  const raycastPart=(clientX:number,clientY:number,options?:{ignoreRetractor?:boolean;allowIntegumentary?:boolean})=>{
   const rect=renderer.domElement.getBoundingClientRect();
   pointer.set((clientX-rect.left)/rect.width*2-1,-(clientY-rect.top)/rect.height*2+1);
   raycaster.setFromCamera(pointer,camera);
   const s=latest.current;
   const hasSolid=!options?.allowIntegumentary&&atlas.parts.some((p,i)=>p.system!=='integumentary'&&data[i*4+3]>.5);
   retractorVec.fromArray(s.retractor.point);

   let nearest=Infinity,found=-1,bestHit:T.Intersection|null=null;
   pickers.forEach((mesh,i)=>{
    if(!mesh||data[i*4+3]<.5||(hasSolid&&atlas.parts[i].system==='integumentary'))return;
    worldBox.copy(bounds[i]).translate(mesh.position);
    if(!raycaster.ray.intersectBox(worldBox,hitPoint))return;
    const hits=raycaster.intersectObject(mesh,false);
    for(const h of hits){
     if(h.distance>=nearest)break;
     // Skip clipped geometry when slicer is active
     if(s.slicer.active&&clipPlane.distanceToPoint(h.point)<0)continue;
     // Skip superficial tissue inside the surgical retractor window so deep organs can be clicked/dissected!
     if(!options?.ignoreRetractor&&s.retractor.active&&isSuperficialSystem(atlas.parts[i].system,s.retractor.cutBone)){
      if(h.point.distanceTo(retractorVec)<s.retractor.radius)continue;
     }
     nearest=h.distance;
     found=i;
     bestHit=h;
     break;
    }
   });
   return {found,hit:bestHit as T.Intersection|null};
  };

  let isToolDragging=false;
  let lastScalpelTime=0;
  let grabbedIndex=-1;
  const grabPlane=new T.Plane();
  const grabStartPoint=new T.Vector3();
  const grabIntersect=new T.Vector3();
  const grabInitialDelta:[number,number,number]=[0,0,0];

  const down=(e:PointerEvent)=>{
   hover.hidden=true;
   const s=latest.current;
   if(!ready)return;

   if(s.tool==='scalpel'&&e.button===0){
    const {found}=raycastPart(e.clientX,e.clientY);
    if(found>=0){
     isToolDragging=true;
     controls.enabled=false;
     lastScalpelTime=performance.now();
     dissect.current(atlas.parts[found].id);
     return;
    }
   }else if(s.tool==='retractor'&&e.button===0){
    const {found,hit}=raycastPart(e.clientX,e.clientY,{ignoreRetractor:true,allowIntegumentary:true});
    if(found>=0&&hit){
     isToolDragging=true;
     controls.enabled=false;
     const n=hit.face?.normal?.clone().transformDirection(hit.object.matrixWorld)??camera.position.clone().sub(hit.point).normalize();
     placeRetractor.current([hit.point.x,hit.point.y,hit.point.z],[n.x,n.y,n.z]);
     return;
    }
   }else if(s.tool==='forceps'&&e.button===0){
    const {found,hit}=raycastPart(e.clientX,e.clientY);
    if(found>=0&&hit){
     isToolDragging=true;
     controls.enabled=false;
     grabbedIndex=found;
     const partId=atlas.parts[found].id;
     const existing=s.displaced[partId]??[0,0,0];
     grabInitialDelta[0]=existing[0];grabInitialDelta[1]=existing[1];grabInitialDelta[2]=existing[2];
     const camDir=camera.getWorldDirection(new T.Vector3()).negate();
     grabPlane.setFromNormalAndCoplanarPoint(camDir,hit.point);
     grabStartPoint.copy(hit.point);
     select.current(partId);
     return;
    }
   }

   tap.down(e.pointerId,e.clientX,e.clientY,e.pointerType==='touch'?12:5);
  };

  const move=(e:PointerEvent)=>{
   const s=latest.current;
   if(isToolDragging){
    if(s.tool==='scalpel'){
     const now=performance.now();
     if(now-lastScalpelTime>120){
      const {found}=raycastPart(e.clientX,e.clientY);
      if(found>=0){
       lastScalpelTime=now;
       dissect.current(atlas.parts[found].id);
      }
     }
    }else if(s.tool==='retractor'){
     const {found,hit}=raycastPart(e.clientX,e.clientY,{ignoreRetractor:true,allowIntegumentary:true});
     if(found>=0&&hit){
      const n=hit.face?.normal?.clone().transformDirection(hit.object.matrixWorld)??camera.position.clone().sub(hit.point).normalize();
      placeRetractor.current([hit.point.x,hit.point.y,hit.point.z],[n.x,n.y,n.z]);
     }
    }else if(s.tool==='forceps'&&grabbedIndex>=0){
     const rect=renderer.domElement.getBoundingClientRect();
     pointer.set((e.clientX-rect.left)/rect.width*2-1,-(e.clientY-rect.top)/rect.height*2+1);
     raycaster.setFromCamera(pointer,camera);
     if(raycaster.ray.intersectPlane(grabPlane,grabIntersect)){
      const diff=grabIntersect.clone().sub(grabStartPoint);
      const partId=atlas.parts[grabbedIndex].id;
      displace.current(partId,[
       grabInitialDelta[0]+diff.x,
       grabInitialDelta[1]+diff.y,
       grabInitialDelta[2]+diff.z,
      ]);
     }
    }
    return;
   }

   tap.move(e.pointerId,e.clientX,e.clientY);
   if(e.buttons||e.pointerType==='touch'){hover.hidden=true;return;}

   // Show hover tooltip in both normal surgical modes and exploded view
   const rect=el.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top;
   if(s.tool!=='inspect'||amount>.5){
    let index=-1;
    if(amount>.5){
     index=findTarget(x,y,12);
    }else{
     const {found}=raycastPart(e.clientX,e.clientY,{ignoreRetractor:s.tool==='retractor'});
     index=found;
    }
    hover.hidden=index<0;
    const toolCursor=s.tool==='scalpel'?'crosshair':s.tool==='retractor'?'cell':s.tool==='forceps'?'move':'pointer';
    renderer.domElement.style.cursor=index<0?(s.tool==='inspect'?'grab':toolCursor):toolCursor;
    if(index>=0){
     const prefix=s.tool==='scalpel'?'🔪 Cut: ':s.tool==='forceps'?'镊 Pull: ':s.tool==='retractor'?'⭕ Incise at: ':'';
     hover.textContent=prefix+atlas.parts[index].name;
     hover.style.left=`${Math.max(8,Math.min(x+14,el.clientWidth-260))}px`;
     hover.style.top=`${Math.max(8,Math.min(y+18,el.clientHeight-55))}px`;
    }
   }else{
    hover.hidden=true;
    renderer.domElement.style.cursor='grab';
   }
  };

  const endDrag=()=>{
   if(isToolDragging){
    isToolDragging=false;
    grabbedIndex=-1;
    controls.enabled=true;
   }
  };

  const cancel=(e:PointerEvent)=>{endDrag();tap.cancel(e.pointerId);};
  const up=(e:PointerEvent)=>{
   if(isToolDragging){
    endDrag();
    return;
   }
   const validTap=tap.up(e.pointerId,e.clientX,e.clientY);if(!validTap||!ready)return;
   let {found}=raycastPart(e.clientX,e.clientY);
   if(found<0&&amount>.45){
    const rect=renderer.domElement.getBoundingClientRect();
    found=findTarget(e.clientX-rect.left,e.clientY-rect.top,e.pointerType==='touch'?24:16);
   }
   if(found>=0){
    hover.hidden=true;
    const partId=atlas.parts[found].id;
    if(latest.current.tool==='scalpel'){
     dissect.current(partId);
    }else{
     select.current(partId);
    }
   }
  };

  renderer.domElement.addEventListener('pointerdown',down);renderer.domElement.addEventListener('pointermove',move);renderer.domElement.addEventListener('pointerup',up);renderer.domElement.addEventListener('pointercancel',cancel);
  const clock=new T.Clock();let lastExtent=-1;

  const animate=()=>{
   if(disposed)return;frame=requestAnimationFrame(animate);const dt=Math.min(clock.getDelta(),.05),s=latest.current;
   const changed=
    lastState?.visible!==s.visible||
    lastState?.selected!==s.selected||
    lastState?.isolate!==s.isolate||
    lastState?.dissected!==s.dissected||
    lastState?.displaced!==s.displaced||
    lastState?.retractor!==s.retractor||
    lastState?.slicer!==s.slicer;

   const moving=Math.abs(amount-s.explode)>.0001;
   if(moving){amount=T.MathUtils.damp(amount,s.explode,8,dt);dirty=true;}
   if(changed||moving||lastExtent<0){
    const visible=new Set(s.visible),selection=new Set(s.selected),dissectedSet=new Set(s.dissected);
    const visibleParts=atlas.parts.filter(p=>!dissectedSet.has(p.id)&&(s.isolate?selection.has(p.id):visible.has(p.system)||selection.has(p.id)));
    const nextLayoutKey=visibleParts.map(p=>p.id).join(',')+':'+camera.aspect.toFixed(3);
    if(nextLayoutKey!==layoutKey){const layout=createExplosionLayout(visibleParts,camera.aspect);packingWidth=layout.width;packingHeight=layout.height;atlas.parts.forEach((p,i)=>{const cell=layout.cells.get(p.id);offsets[i]=cell?new T.Vector3(cell.x,cell.y+.85,0):centers[i].clone();});layoutKey=nextLayoutKey;if(amount>.05&&!s.isolate)fit(s.view,Math.max(0,(amount-.3)/.7));}

    // Update Retractor shader uniforms & 3D ring indicator
    retractorUniforms.forEach((u,sys)=>{
     u.pos.value.fromArray(s.retractor.point);
     u.radius.value=s.retractor.active&&isSuperficialSystem(sys,s.retractor.cutBone)?s.retractor.radius:0;
    });
    if(s.retractor.active){
     retractorRing.visible=true;
     retractorRing.position.fromArray(s.retractor.point);
     retractorRing.scale.setScalar(s.retractor.radius);
     const normal=new T.Vector3().fromArray(s.retractor.normal).normalize();
     retractorRing.quaternion.setFromUnitVectors(new T.Vector3(0,0,1),normal);
    }else{
     retractorRing.visible=false;
    }

    // Update Cross-Section Slicer plane
    if(s.slicer.active){
     const sign=s.slicer.flip?1:-1;
     if(s.slicer.axis==='axial'){
      // Y-axis: 0.05 to 1.75m
      const y=T.MathUtils.lerp(0.05,1.75,s.slicer.position);
      clipPlane.set(new T.Vector3(0,sign,0),-sign*y);
      sliceHelper.position.set(0,y,0);
      sliceHelper.rotation.set(-Math.PI/2,0,0);
     }else if(s.slicer.axis==='sagittal'){
      // X-axis: -0.35 to 0.35m
      const x=T.MathUtils.lerp(-0.35,0.35,s.slicer.position);
      clipPlane.set(new T.Vector3(sign,0,0),-sign*x);
      sliceHelper.position.set(x,0.95,0);
      sliceHelper.rotation.set(0,Math.PI/2,0);
     }else{
      // Coronal Z-axis: -0.22 to 0.22m
      const z=T.MathUtils.lerp(-0.22,0.22,s.slicer.position);
      clipPlane.set(new T.Vector3(0,0,sign),-sign*z);
      sliceHelper.position.set(0,0.95,z);
      sliceHelper.rotation.set(0,0,0);
     }
     sliceHelper.visible=true;
     mats.forEach(m=>{m.clippingPlanes=[clipPlane];m.needsUpdate=true;});
    }else{
     sliceHelper.visible=false;
     mats.forEach(m=>{if(m.clippingPlanes?.length){m.clippingPlanes=[];m.needsUpdate=true;}});
    }

    atlas.parts.forEach((p,i)=>{
     const c=centers[i],destination=offsets[i];let dx=0,dy=0,dz=0;
     if(amount<=.45){const t=amount/.45;const group=SYSTEMS.findIndex(sys=>sys.id===p.system);const angle=group/SYSTEMS.length*Math.PI*2;dx=Math.sin(angle)*t*.48;dy=(c.y-.85)*t*.28;dz=Math.cos(angle)*t*.48;}
     else {const t=(amount-.45)/.55,group=SYSTEMS.findIndex(sys=>sys.id===p.system),angle=group/SYSTEMS.length*Math.PI*2;dx=T.MathUtils.lerp(Math.sin(angle)*.48,destination.x-c.x,t);dy=T.MathUtils.lerp((c.y-.85)*.28,destination.y-c.y,t);dz=T.MathUtils.lerp(Math.cos(angle)*.48,-c.z,t);}
     const custom=s.displaced[p.id];
     if(custom){dx+=custom[0];dy+=custom[1];dz+=custom[2];}
     const selected=selection.has(p.id);
     const isPartVisible=!dissectedSet.has(p.id)&&(s.isolate?selected:visible.has(p.system)||selected);
     data.set([dx,dy,dz,isPartVisible?1:0],i*4);selectedData[i*4]=selected?255:0;
     markerPositions.set(data[i*4+3]>.5?[c.x+dx,c.y+dy,c.z+dz]:[10000,10000,10000],i*3);const mesh=pickers[i];if(mesh){mesh.position.set(dx,dy,dz);mesh.updateMatrix();mesh.updateMatrixWorld(true);}
    });partTexture.needsUpdate=true;selectionTexture.needsUpdate=true;markerGeometry.attributes.position.needsUpdate=true;lastState=s;lastExtent=amount;dirty=true;
   }
   if(s.view!==lastView||s.reset!==lastReset){fit(s.view,amount);lastView=s.view;lastReset=s.reset;}
   if(moving&&!s.isolate)fit(amount>.5?'front':s.view,Math.max(0,(amount-.3)/.7));
   const isolateKey=s.isolate?s.selected.join(',')+':'+s.reset+':'+s.inspectorOpen+':'+camera.aspect:'';
   if(isolateKey!==lastIsolate||(s.isolate&&moving)){
    if(s.isolate){const box=new T.Box3();atlas.parts.forEach((p,i)=>{if(s.selected.includes(p.id))box.union(bounds[i].clone().translate(new T.Vector3(data[i*4],data[i*4+1],data[i*4+2])));});
     if(!box.isEmpty()){const center=box.getCenter(new T.Vector3()),size=box.getSize(new T.Vector3());const w=el.clientWidth,h=el.clientHeight,mobile=w<768,landscape=w>h&&h<=600;let left=20,right=w-20,top=mobile?175:110,bottom=h-170;if(s.inspectorOpen){if(landscape){right=w-335;top=100;bottom=h-125;}else if(mobile){const sheet=document.querySelector('.detail-sheet')?.getBoundingClientRect(),header=document.querySelector('.identity')?.getBoundingClientRect();top=(header?.bottom??94)+16;bottom=(sheet?.top??h*.58-139)-16;}else{right=w-370;left=w>1100?285:25;}}const availableWidth=Math.max(150,right-left),availableHeight=Math.max(40,bottom-top);camera.setViewOffset(w,h,w/2-(left+right)/2,h/2-(top+bottom)/2,w,h);const distance=Math.max(.07,Math.max(size.y*h/availableHeight,size.x*w/availableWidth/camera.aspect,size.z)/(2*Math.tan(T.MathUtils.degToRad(camera.fov/2)))*1.35);controls.maxDistance=Math.max(40,distance*2);controls.target.copy(center);camera.position.copy(center).add(new T.Vector3(.2,.1,1).normalize().multiplyScalar(distance));controls.update();dirty=true;}
    }else if(lastIsolate){camera.clearViewOffset();fit(s.view,amount);}
    lastIsolate=isolateKey;
   }
   if(!isToolDragging){
    controls.enableRotate=amount<.8;
   }
   controls.mouseButtons.LEFT=amount<.8?T.MOUSE.ROTATE:T.MOUSE.PAN;controls.touches.ONE=amount<.8?T.TOUCH.ROTATE:T.TOUCH.PAN;ground.visible=platform.visible=ring.visible=innerRing.visible=amount<.5&&!s.isolate;markers.visible=amount>.75;controls.autoRotate=s.rotate&&!s.isolate&&amount<.4;controls.autoRotateSpeed=.65;controls.update();if(controls.autoRotate)dirty=true;
   if(dirty){renderer.render(scene,camera);targets=[];if(amount>.45){const hasSolid=atlas.parts.some((p,i)=>p.system!=='integumentary'&&data[i*4+3]>.5);atlas.parts.forEach((p,i)=>{if(data[i*4+3]<.5||(hasSolid&&p.system==='integumentary'))return;let left=Infinity,right=-Infinity,top=Infinity,bottom=-Infinity;for(let corner=0;corner<8;corner++){projected.set(p.bounds[(corner&1)?1:0][0]+data[i*4],p.bounds[(corner&2)?1:0][1]+data[i*4+1],p.bounds[(corner&4)?1:0][2]+data[i*4+2]).project(camera);const x=(projected.x+1)*el.clientWidth/2,y=(1-projected.y)*el.clientHeight/2;left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}projected.copy(centers[i]).add(new T.Vector3(data[i*4],data[i*4+1],data[i*4+2])).project(camera);if(projected.z< -1||projected.z>1)return;targets.push({index:i,x:(projected.x+1)*el.clientWidth/2,y:(1-projected.y)*el.clientHeight/2,left,right,top,bottom});});}dirty=false;}

  };animate();
  const contextLost=(e:Event)=>{e.preventDefault();onError('The 3D session was paused by your device. Reload to continue.');};renderer.domElement.addEventListener('webglcontextlost',contextLost);
  return()=>{disposed=true;abort.abort();cancelAnimationFrame(frame);observer.disconnect();controls.dispose();retractorGeo.dispose();retractorMat.dispose();sliceHelperGeo.dispose();sliceHelperMat.dispose();geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());scene.traverse(o=>{if(o instanceof T.Mesh&&!geometries.includes(o.geometry)){o.geometry.dispose();const ms=Array.isArray(o.material)?o.material:[o.material];ms.forEach(m=>m.dispose());}});env.dispose();partTexture.dispose();selectionTexture.dispose();markerGeometry.dispose();markerMaterial.dispose();hover.remove();renderer.dispose();renderer.domElement.remove();};
 },[atlas]);
 return <div className="scene" ref={host}/>;
}
