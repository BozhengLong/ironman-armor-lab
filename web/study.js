import * as THREE from 'three';

export const STUDY_VIEW = [0.6, 0.35, 1];
export const STUDY_STAGES = ['原位观察', '展开大件', '分离细件'];
export const PART_NAMES = {helmet:'头盔',neck:'颈部',chest:'胸甲',abdomen:'腹部',pelvis:'腰甲',shoulder:'肩甲',upper_arm:'上臂',forearm:'前臂',hand:'手部',thigh:'大腿',shin:'小腿',foot:'足部'};
export const SIDE_NAMES = {C:'中央',L:'左侧',R:'右侧'};

// This is a viewing arrangement, not a claim about a real mechanism. Pack actual
// projected bounds, keeping the original geometry and each part's orientation.
export function prepareStudy(parts, groups) {
  const eye=new THREE.Vector3(...STUDY_VIEW).normalize();
  const right=new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0),eye).normalize();
  const up=new THREE.Vector3().crossVectors(eye,right).normalize();
  const groupData=new Map();
  const corner=new THREE.Vector3(), inv=new THREE.Matrix4();
  for(const p of parts) {
    p.obj.updateWorldMatrix(true,false);
    const center=p.localBox.getCenter(new THREE.Vector3()).applyMatrix4(p.obj.matrixWorld);
    let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
    for(let i=0;i<8;i++) {
      corner.set(i&1?p.localBox.max.x:p.localBox.min.x,i&2?p.localBox.max.y:p.localBox.min.y,i&4?p.localBox.max.z:p.localBox.min.z).applyMatrix4(p.obj.matrixWorld);
      const x=corner.dot(right),y=corner.dot(up);
      x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);
    }
    p.study={center,width:x1-x0,height:y1-y0,worldOffset:new THREE.Vector3(),localOffset:new THREE.Vector3(),large:false};
    if(!groupData.has(p.groupKey))groupData.set(p.groupKey,[]);
    groupData.get(p.groupKey).push(p);
  }
  for(const [key,list] of groupData) {
    const sorted=[...list].sort((a,b)=>b.study.width*b.study.height-a.study.width*a.study.height || a.meta.node-b.meta.node);
    const biggest=sorted[0].study.width*sorted[0].study.height;
    sorted.forEach((p,i)=>{p.study.large=i===0 || p.study.width*p.study.height>=biggest*.24;});
    // Large pieces are encountered first. Small details occupy their own rows, so
    // they do not turn into specks between large shells at the recommended angle.
    const large=sorted.filter(p=>p.study.large),small=sorted.filter(p=>!p.study.large);
    const width=Math.max(...sorted.map(p=>p.study.width)),height=Math.max(...sorted.map(p=>p.study.height));
    const gap=Math.max(width,height)*.12+.008;
    const cols=Math.min(3,large.length);
    const rows=[];
    for(const chunk of [large,small]) {
      const count=chunk===large?cols:Math.min(5,Math.max(2,Math.ceil(Math.sqrt(chunk.length*2))));
      for(let i=0;i<chunk.length;i+=count)rows.push(chunk.slice(i,i+count));
    }
    const center=list.reduce((v,p)=>v.add(p.study.center),new THREE.Vector3()).multiplyScalar(1/list.length);
    const totalHeight=rows.reduce((s,r)=>s+Math.max(...r.map(p=>p.study.height))+gap,0)-gap;
    let y=totalHeight/2;
    for(const row of rows) {
      const rowHeight=Math.max(...row.map(p=>p.study.height));
      const rowWidth=row.reduce((s,p)=>s+p.study.width+gap,0)-gap;
      let x=-rowWidth/2;
      for(const p of row) {
        const target=center.clone().addScaledVector(right,x+p.study.width/2).addScaledVector(up,y-rowHeight/2);
        p.study.worldOffset.copy(target).sub(p.study.center);
        inv.copy(p.obj.parent.matrixWorld).invert();
        p.study.localOffset.copy(target).applyMatrix4(inv).sub(p.study.center.clone().applyMatrix4(inv));
        p.study.order=sorted.indexOf(p);
        x+=p.study.width+gap;
      }
      y-=rowHeight+gap;
    }
    groupData.set(key,{parts:sorted,large:large.length,small:small.length,center});
  }
  return groupData;
}

export function studyFactor(p,progress) {
  return THREE.MathUtils.smoothstep(progress,p.study.large?0:1,p.study.large?1:2);
}

// A front locator from actual assembled bounds, not a generic humanoid silhouette.
// It remains fixed while the main view is taken apart or rotated.
export function drawLocator(svg,parts,selected,focus) {
  if(!parts.length)return;
  const ns='http://www.w3.org/2000/svg';
  svg.replaceChildren();
  const bounds=new THREE.Box3();
  const items=parts.map(p=>{
    const b=p.localBox.clone().applyMatrix4(p.obj.matrixWorld);
    const current=b.getCenter(new THREE.Vector3());
    b.translate(p.study.center.clone().sub(current));bounds.union(b);return {p,b};
  });
  const scale=Math.min(90/Math.max(bounds.max.x-bounds.min.x,.01),106/Math.max(bounds.max.y-bounds.min.y,.01));
  const mid=(bounds.min.x+bounds.max.x)/2;
  items.sort((a,b)=>(a.p.groupKey===selected?1:0)-(b.p.groupKey===selected?1:0));
  for(const {p,b} of items) {
    const rect=document.createElementNS(ns,'rect');
    rect.setAttribute('x',String(55+(b.min.x-mid)*scale));rect.setAttribute('y',String(7+(bounds.max.y-b.max.y)*scale));
    rect.setAttribute('width',String(Math.max(1.5,(b.max.x-b.min.x)*scale)));rect.setAttribute('height',String(Math.max(1.5,(b.max.y-b.min.y)*scale)));
    const active=p.groupKey===selected&&(focus<0||p.focusIndex===focus);
    rect.setAttribute('class',active?'located':'context');rect.dataset.node=p.meta.node;
    svg.append(rect);
  }
  svg.setAttribute('aria-label',`整体位置：${SIDE_NAMES[selected?.split('/')[1]]||''}${PART_NAMES[selected?.split('/')[0]]||''}${focus>=0?'，第 '+(focus+1)+' 件':''}`);
}
