
const DB='novel-world-reading-assets';
async function database() {
  return new Promise((resolve,reject)=>{const r=indexedDB.open(DB,1);r.onupgradeneeded=()=>r.result.createObjectStore('fonts');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
async function fontStore(mode,operation) {
  const db=await database();
  try { return await new Promise((resolve,reject)=>{const tx=db.transaction('fonts',mode);const r=operation(tx.objectStore('fonts'));let value;r.onsuccess=()=>{value=r.result;};tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);}); }
  finally {db.close();}
}
export async function readFont() {return fontStore('readonly',s=>s.get('custom'));}
export async function removeFont() {return fontStore('readwrite',s=>s.delete('custom'));}
export async function importFont(file) {
  if(!/.(ttf|otf|woff2?)$/i.test(file.name)||file.size>40*1024*1024)throw new Error('请选择不超过 40 MB 的 TTF、OTF、WOFF 或 WOFF2 字体');
  const bytes=await file.arrayBuffer();
  await new FontFace('NovelWorldCustom',bytes).load();
  const value={name:file.name,bytes};await fontStore('readwrite',s=>s.put(value,'custom'));return value;
}
export async function avatarImage(file) {
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>15*1024*1024)throw new Error('请选择 15 MB 以内的 PNG、JPEG 或 WebP 图片');
  const bitmap=await createImageBitmap(file);
  try {
    const canvas=document.createElement('canvas');canvas.width=canvas.height=256;
    const size=Math.min(bitmap.width,bitmap.height);
    canvas.getContext('2d').drawImage(bitmap,(bitmap.width-size)/2,(bitmap.height-size)/2,size,size,0,0,256,256);
    return canvas.toDataURL('image/webp',0.82);
  } finally {bitmap.close();}
}
