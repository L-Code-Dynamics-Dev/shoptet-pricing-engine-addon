import {sha256,validateAssetManifest} from './asset-deployment.mjs';
const RELEASE=/^[A-Za-z0-9_-]{1,80}$/;
const SHOP=/^[A-Za-z0-9_-]{1,128}$/;
// Immutable, per-shop release assets. No agent-supplied object paths.
export function createR2AssetProvider(bucket){
 if(typeof bucket?.get!=='function')throw new Error('Asset provider unavailable');
 return {async get({shopId,releaseId,manifest}){
  if(!SHOP.test(shopId??'')||!RELEASE.test(releaseId??''))throw new Error('Invalid release');
  const entries=validateAssetManifest(manifest);
  const assets=Object.create(null);
  for(const entry of entries){
   const obj=await bucket.get(`releases/${shopId}/${releaseId}/${entry.name}`);
   if(!obj)throw new Error('Release asset missing');
   const bytes=new Uint8Array(await obj.arrayBuffer());
   if(bytes.length>262144)throw new Error('Asset too large');
   const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
   if(await sha256(content)!==entry.sha256)throw new Error('Release integrity failure');
   assets[entry.name]=content;
  }
  return assets;
 }};
}
