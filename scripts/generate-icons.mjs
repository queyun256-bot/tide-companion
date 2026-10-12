// Regenerate checked-in icon assets after editing shark.svg.
// Requires sharp: SHARP_MODULE may identify an existing local installation.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),sharp=require(process.env.SHARP_MODULE||'sharp');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const body=(await readFile(path.join(root,'assets/shark.svg'),'utf8')).replace(/<svg\b[^>]*>/,'<svg x="6" y="6" width="244" height="244" viewBox="50 28 310 285" fill="none">');
const source=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect x="1" y="1" width="254" height="254" rx="62" fill="#fff2f8" stroke="#ecc4d7" stroke-width="2"/>${body}</svg>`);
await writeFile(path.join(root,'assets/app.png'),await sharp(source).png().toBuffer());
// Windows shell icon extraction is not consistent for all-PNG icon groups.
// Use classic 32-bit DIB entries at small sizes, with PNG only at 256 px.
function iconDib(rgba,size){
  const maskStride=Math.ceil(size/32)*4,pixels=size*size*4;
  const dib=Buffer.alloc(40+pixels+maskStride*size);
  dib.writeUInt32LE(40,0);dib.writeInt32LE(size,4);dib.writeInt32LE(size*2,8);
  dib.writeUInt16LE(1,12);dib.writeUInt16LE(32,14);dib.writeUInt32LE(pixels+maskStride*size,20);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const from=(y*size+x)*4,to=40+((size-1-y)*size+x)*4;
    dib[to]=rgba[from+2];dib[to+1]=rgba[from+1];dib[to+2]=rgba[from];dib[to+3]=rgba[from+3];
    if(rgba[from+3]===0)dib[40+pixels+(size-1-y)*maskStride+(x>>3)]|=0x80>>(x&7);
  }
  return dib;
}
const sizes=[16,24,32,48,64,128,256],images=await Promise.all(sizes.map(async size=>size===256
  ? sharp(source).resize(size,size).png().toBuffer()
  : iconDib(await sharp(source).resize(size,size).ensureAlpha().raw().toBuffer(),size)));
const header=Buffer.alloc(6+16*images.length);header.writeUInt16LE(1,2);header.writeUInt16LE(images.length,4);
let offset=header.length;
images.forEach((img,i)=>{const at=6+i*16,size=sizes[i];header[at]=size===256?0:size;header[at+1]=size===256?0:size;header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);header.writeUInt32LE(img.length,at+8);header.writeUInt32LE(offset,at+12);offset+=img.length;});
await writeFile(path.join(root,'assets/app.ico'),Buffer.concat([header,...images]));
console.log('Generated app.png and 7-size app.ico from the original shark SVG.');
