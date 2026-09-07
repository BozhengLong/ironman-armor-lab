import * as THREE from 'three';

// Presentation only: source assets, manifest bindings and displacement plans stay intact.
const HULKBUSTER_PALETTE = {
  Gold_1:'#b29a69', Gold_2:'#b29a69', Gold_4:'#b29a69',
  iron:'#566571', Iron_2:'#566571', material:'#566571', material_18:'#566571',
  legs_down:'#96392f', Legs:'#96392f', forearm:'#96392f', Feet:'#96392f',
  foot:'#71352e', Face:'#b29a69', Object037__0:'#a43f32', Torsi:'#96392f', Pelvis:'#96392f',
};
const GROUP_NAMES = {helmet:'HELMET',chest:'CHEST',abdomen:'ABDOMEN',pelvis:'PELVIS',
  shoulder:'SHOULDER',upper_arm:'UPPER ARM',forearm:'FOREARM',hand:'HAND',
  thigh:'THIGH',shin:'SHIN',foot:'FOOT',neck:'NECK'};
const ns='http://www.w3.org/2000/svg';
const svg = (tag) => document.createElementNS(ns,tag);

export function createPresentation({camera, state, getParts, getGroups, selectGroup, stopTour, scheduleUrlSync, slug}) {
  const $=id=>document.getElementById(id);
  const layer=$('annotations'), leaders=$('leaders');
  const original=new WeakMap();
  const params=new URLSearchParams(location.search);
  let edgeObjects=[], annotations=[], engineering=params.get('finish')!=='source', labelsOn=params.get('labels')!=='0', layout=null;
  let lastStamp='', lastLabelTime=-Infinity;
  const box=new THREE.Box3(), anchor=new THREE.Vector3();
  const q=new THREE.Quaternion(), corner=new THREE.Vector3();

  function visible(el) { return !!el && el.getClientRects().length>0 && getComputedStyle(el).display!=='none'; }
  function measure() {
    const mobile=innerWidth<=820, dock=$('ctl').getBoundingClientRect();
    const side=visible($('inspect'))?$('inspect'):$('roster');
    const title=$('drawing').getBoundingClientRect();
    const top=mobile ? Math.max(title.bottom,side.getBoundingClientRect().bottom)+16 : title.bottom+18;
    const left=mobile?18:title.left;
    const right=mobile?innerWidth-18:$('tele').getBoundingClientRect().left-28;
    layout={mobile,left,right,top,bottom:Math.max(top+80,dock.top-22)};
    layout.width=right-left;layout.height=layout.bottom-top;
    const cx=(left+right)/2,cy=(top+layout.bottom)/2;
    camera.setViewOffset(innerWidth,innerHeight,innerWidth/2-cx,innerHeight/2-cy,innerWidth,innerHeight);
    // Scrims follow their actual panels, including expanded settings and mobile credit.
    for(const [id,selectors] of [['scrimL',['.hd','#roster','#inspect']],['scrimR',['#tele']],
      ['scrimB',['#ctl']],['scrimC',['#credit','#tour']]]) {
      const rects=selectors.map(s=>document.querySelector(s)).filter(visible).map(e=>e.getBoundingClientRect());
      const el=$(id);el.style.display=rects.length?'block':'none';
      if(!rects.length)continue;
      const l=Math.min(...rects.map(r=>r.left)),t=Math.min(...rects.map(r=>r.top));
      const r=Math.max(...rects.map(r=>r.right)),b=Math.max(...rects.map(r=>r.bottom));
      // The header occupies a wide strip. Do not fill the entire left panel union.
      el.style.cssText=`display:block;left:${l-4}px;top:${t-4}px;width:${r-l+8}px;height:${b-t+8}px`;
      if(id==='scrimL')el.style.background='linear-gradient(90deg, var(--bg), transparent 250px)';
    }
    lastLabelTime=-Infinity;
  }
  const observer=new ResizeObserver(measure);
  ['ctl','roster','inspect','tele','drawing','credit','tour'].forEach(id=>observer.observe($(id)));
  addEventListener('resize',measure);

  const frameTarget=new THREE.Vector3();
  // Project the transformed local bounds of actual visible parts. Projecting one global
  // axis-aligned box twice makes sparse exploded assemblies unnecessarily tiny.
  function frame() {
    if(!layout)measure();
    q.copy(camera.quaternion).invert();
    let x0=Infinity,y0=Infinity,z0=Infinity,x1=-Infinity,y1=-Infinity,z1=-Infinity;
    for(const p of getParts()) {
      if(state.selected && (p.groupKey!==state.selected || (state.focus>=0&&p.focusIndex!==state.focus)))continue;
      p.obj.updateWorldMatrix(true,false);
      const lo=p.localBox.min,hi=p.localBox.max;
      for(let i=0;i<8;i++) {
        corner.set(i&1?hi.x:lo.x,i&2?hi.y:lo.y,i&4?hi.z:lo.z).applyMatrix4(p.obj.matrixWorld).applyQuaternion(q);
        x0=Math.min(x0,corner.x);x1=Math.max(x1,corner.x);y0=Math.min(y0,corner.y);y1=Math.max(y1,corner.y);
        z0=Math.min(z0,corner.z);z1=Math.max(z1,corner.z);
      }
    }
    if(!Number.isFinite(x0))return {zoom:1,target:frameTarget.set(0,0,0)};
    frameTarget.set((x0+x1)/2,(y0+y1)/2,(z0+z1)/2).applyQuaternion(camera.quaternion);
    const width=Math.max(80,layout.width-(!layout.mobile&&labelsOn?320:20));
    const height=Math.max(40,layout.height-24);
    return {zoom:1.5/innerHeight/Math.max((x1-x0)/width,(y1-y0)/height,1e-6),target:frameTarget};
  }

  function styleMaterials() {
    for(const p of getParts())for(const mesh of p.meshes)for(const m of (Array.isArray(mesh.material)?mesh.material:[mesh.material])) {
      if(!original.has(m)) original.set(m,{color:m.color.clone(),metalness:m.metalness,roughness:m.roughness,
        polygonOffset:m.polygonOffset,polygonOffsetFactor:m.polygonOffsetFactor,polygonOffsetUnits:m.polygonOffsetUnits});
      const src=original.get(m);
      m.color.copy(src.color);m.metalness=src.metalness;m.roughness=src.roughness;
      if(engineering) {
        if(slug==='hulkbuster'&&!p.meta.emissive&&HULKBUSTER_PALETTE[m.name]) {
          m.color.set(HULKBUSTER_PALETTE[m.name]);m.metalness=.35;m.roughness=.58;
        } else if(!p.meta.emissive) {
          m.metalness=Math.min(src.metalness??0,.55);
          m.roughness=Math.max(src.roughness??.5,.56);
        }
      }
      m.polygonOffset=engineering||src.polygonOffset;
      m.polygonOffsetFactor=engineering?1:src.polygonOffsetFactor;
      m.polygonOffsetUnits=engineering?1:src.polygonOffsetUnits;
    }
    lastStamp='';
  }

  function buildEdges() {
    for(const {line} of edgeObjects){line.removeFromParent();line.geometry.dispose();line.material.dispose();}
    edgeObjects=[];
    for(const p of getParts())for(const mesh of p.meshes) {
      const geo=new THREE.EdgesGeometry(mesh.geometry,42);
      if(!geo.getAttribute('position').count){geo.dispose();continue;}
      const line=new THREE.LineSegments(geo,new THREE.LineBasicMaterial({color:0x9ab4c1,transparent:true,
        opacity:.18,depthWrite:false,toneMapped:false}));
      line.name='drawing-edges';line.raycast=()=>{};
      mesh.add(line);edgeObjects.push({line,p});
    }
  }

  function buildLabels() {
    for(const a of annotations)a.button.remove();leaders.replaceChildren();annotations=[];
    const groups=getGroups();
    const priorities=['helmet/C','chest/C','forearm/L','forearm/R','thigh/L','thigh/R','abdomen/C','shoulder/R','chest/L','shin/L'];
    const chosen=priorities.filter(k=>groups[k]).slice(0,6);
    if(state.selected&&!chosen.includes(state.selected))chosen.push(state.selected);
    chosen.forEach((key,i)=>{
      const g=groups[key];const name=GROUP_NAMES[g.part]||g.part.replaceAll('_',' ').toUpperCase();
      const side=g.side==='C'?'CENTER':g.side==='L'?'LEFT':'RIGHT';
      const button=document.createElement('button');button.className='callout';button.dataset.group=key;
      button.setAttribute('aria-label',`Inspect ${side.toLowerCase()} ${name.toLowerCase()}`);
      const num=document.createElement('span');num.className='num';num.textContent=String(i+1).padStart(2,'0');
      const text=document.createElement('span');text.textContent=name;
      const small=document.createElement('small');small.textContent=`${side} / ${g.count} PARTS`;text.append(small);button.append(num,text);
      button.onclick=()=>{stopTour();selectGroup(key);};layer.append(button);
      const path=svg('path'),dot=svg('circle');dot.setAttribute('r','2.5');leaders.append(path,dot);
      annotations.push({key,button,path,dot,side,i,anchor:new THREE.Vector3()});
    });
    lastLabelTime=-Infinity;
  }

  function updateLabels(time) {
    if(time-lastLabelTime<50)return;lastLabelTime=time;
    if(!layout)measure();
    const {mobile,left,right,top,bottom}=layout;
    const columns=[[],[]];
    for(const a of annotations) {
      a.button.hidden=true;a.path.style.display=a.dot.style.display='none';
      if(!labelsOn || mobile || (state.selected&&a.key!==state.selected))continue;
      // A real mesh center moves with the group; no static screen-space anchor guesses.
      const candidates=getParts().filter(p=>p.groupKey===a.key && (state.focus<0||!state.selected||p.focusIndex===state.focus));
      let best=-1,found=false;
      for(const p of candidates) {
        p.obj.updateWorldMatrix(true,false);
        box.copy(p.localBox).applyMatrix4(p.obj.matrixWorld);
        const score=p.meta.tris||0;
        if(score>best){box.getCenter(a.anchor);best=score;found=true;}
      }
      if(!found)continue;
      anchor.copy(a.anchor).project(camera);
      a.ax=(anchor.x*.5+.5)*innerWidth;a.ay=(-anchor.y*.5+.5)*innerHeight;
      if(a.ax<left||a.ax>right||a.ay<top||a.ay>bottom||anchor.z<-1||anchor.z>1)continue;
      let col=a.ax<(left+right)/2?0:1;
      if(a.key==='helmet/C')col=0;if(a.key==='chest/C')col=1;
      a.col=col;columns[col].push(a);
    }
    for(let col=0;col<2;col++) {
      const items=columns[col].sort((a,b)=>a.ay-b.ay);
      const gap=mobile?48:68;
      // Drop low-priority labels on short windows instead of piling them up.
      while(items.length*gap>bottom-top&&items.length>1)items.pop();
      let prev=top-gap;
      for(let i=0;i<items.length;i++) {
        const a=items[i],w=mobile?120:innerWidth<=1100?120:142;
        const y=Math.max(prev+gap,Math.min(a.ay-22,bottom-(items.length-i)*gap));prev=y;
        const x=col===0?left:right-w;
        a.button.style.transform=`translate(${Math.round(x)}px,${Math.round(y)}px)`;
        a.button.hidden=false;a.button.setAttribute('aria-pressed',String(state.selected===a.key));
        const sx=col===0?x+w:x,sy=y+22,elbow=sx+(col===0?16:-16);
        a.path.setAttribute('d',`M${sx},${sy} L${elbow},${sy} L${a.ax.toFixed(1)},${a.ay.toFixed(1)}`);
        a.dot.setAttribute('cx',a.ax.toFixed(1));a.dot.setAttribute('cy',a.ay.toFixed(1));
        a.path.style.display=a.dot.style.display='';
        a.path.classList.toggle('active',state.selected===a.key);a.dot.classList.toggle('active',state.selected===a.key);
      }
    }
  }

  function update(time) {
    const stamp=`${engineering}/${state.selected}/${state.focus}`;
    if(stamp!==lastStamp) {
      for(const {line,p} of edgeObjects) {
        const selected=p.groupKey===state.selected;
        line.visible=engineering&&(!state.selected||selected)&&(state.focus<0||p.focusIndex===state.focus);
        line.material.color.set(selected?0xf17a46:0x9ab4c1);line.material.opacity=selected?.48:.18;
      }
      if(state.selected&&!annotations.some(a=>a.key===state.selected))buildLabels();
      lastStamp=stamp;
    }
    $('explodeValue').textContent=`${Math.round(state.explode*100)}%`;
    updateLabels(time);
  }

  $('btnSettings').onclick=()=>{const open=$('settings').classList.toggle('open');$('btnSettings').setAttribute('aria-expanded',String(open));measure();};
  const updateFinishButton=()=>{$('btnFinish').setAttribute('aria-pressed',String(engineering));$('btnFinish').textContent=engineering?'ENGINEERED':'SOURCE';};
  updateFinishButton();$('btnLabels').setAttribute('aria-pressed',String(labelsOn));
  $('btnFinish').onclick=()=>{engineering=!engineering;updateFinishButton();styleMaterials();scheduleUrlSync();};
  $('btnLabels').onclick=()=>{labelsOn=!labelsOn;$('btnLabels').setAttribute('aria-pressed',String(labelsOn));lastLabelTime=-Infinity;scheduleUrlSync();};
  const api={
    frame,measure,update,
    preferences:()=>({finish:engineering?'engineered':'source',labels:labelsOn}),
    modelLoaded(meta){$('drawingName').textContent=meta.name||slug.toUpperCase();$('drawingSub').textContent=meta.subtitle||'ARMOR STUDY';
      $('drawingCount').textContent=`${Object.keys(getGroups()).length} SUBASSEMBLIES`;
      styleMaterials();buildEdges();buildLabels();measure();},
    verify(){
      const shown=annotations.filter(a=>!a.button.hidden),problems=[];
      let maxGhostOpacity=0;
      if(state.selected&&state.drill>.999) {
        for(const p of getParts())if(p.groupKey!==state.selected)for(const mesh of p.meshes)
          for(const m of (Array.isArray(mesh.material)?mesh.material:[mesh.material])) {
            maxGhostOpacity=Math.max(maxGhostOpacity,m.opacity);
            if(!m.transparent||m.opacity>.03)problems.push(`Opaque context part ${p.meta.node}`);
          }
      }
      const hud=['.hd','#drawing','#tele','#roster','#inspect','#ctl'].map(s=>document.querySelector(s)).filter(visible).map(e=>e.getBoundingClientRect());
      const overlap=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
      const rects=shown.map(a=>a.button.getBoundingClientRect());
      shown.forEach((a,i)=>{const r=rects[i];if(!getGroups()[a.key])problems.push(`Unknown group ${a.key}`);
        if(r.left<0||r.top<0||r.right>innerWidth||r.bottom>innerHeight)problems.push(`Offscreen label ${a.key}`);
        if(hud.some(b=>overlap(r,b)))problems.push(`Label hits HUD ${a.key}`);
        if(rects.slice(i+1).some(b=>overlap(r,b)))problems.push(`Overlapping label ${a.key}`);
        const dotX=Number(a.dot.getAttribute('cx')),dotY=Number(a.dot.getAttribute('cy'));
        if(!Number.isFinite(dotX+dotY)||Math.hypot(dotX-a.ax,dotY-a.ay)>.2)problems.push(`Detached leader ${a.key}`);
      });
      return {ok:!problems.length,problems,visible:shown.map(a=>a.key),maxGhostOpacity,engineering,layout};
    },
    dispose(){observer.disconnect();removeEventListener('resize',measure);for(const {line} of edgeObjects){line.removeFromParent();line.geometry.dispose();line.material.dispose();}},
  };
  return api;
}
