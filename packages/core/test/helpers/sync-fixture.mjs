import {testD1} from './d1.mjs';
import {createConfigurationService} from '../../src/configuration.mjs';
import {createSyncService} from '../../src/sync-service.mjs';
import {createSyncRunner} from '../../src/sync-runner.mjs';
export const PRODUCT='123e4567-e89b-42d3-a456-426614174000',BRAND='123e4567-e89b-42d3-a456-426614174001',CATEGORY='123e4567-e89b-42d3-a456-426614174002';
const clone=v=>JSON.parse(JSON.stringify(v));
export async function syncFixture(overrides={}){
 const db=testD1();db.sql.exec("INSERT INTO installations(shop_id,state) VALUES('101','active'),('202','active')");
 const profile={id:101,name:'Test shop',vatPayer:true,timezone:'Europe/Prague',defaultPricelistId:1,currencies:[{code:'CZK',priceDecimalPlaces:2,rounding:'math'}]};
 const product={guid:PRODUCT,name:'Test product',visibility:'normal',brand:{code:'test-maker',name:'Test maker'},defaultCategory:{guid:CATEGORY},categories:[{guid:CATEGORY}],variants:[{code:'TEST/A',visible:true},{code:'TEST/B',visible:true}]};
 const rows=new Map();for(const id of [1,2])for(const code of ['TEST/A','TEST/B'])rows.set(id+':'+code,{code,currencyCode:'CZK',includingVat:true,vatRate:'21.00',price:{price:'100.00',commonPrice:'100.00',priceRatio:'1.000',actionPrice:null},sales:{discountCoupon:true}});
 let writes=0;const adapter={profile:async()=>clone(profile),product:async()=>clone(product),brand:async()=>({guid:BRAND,name:'Test maker',indexName:'test-maker'}),category:async()=>({guid:CATEGORY,name:'Test category',visible:true}),pricelist:async id=>({id,name:'Test list '+id,currency:'CZK',isDefault:id===1}),prices:async(id,{code})=>({items:rows.has(id+':'+code)?[clone(rows.get(id+':'+code))]:[],pagination:{page:1,pageCount:1,totalCount:1}}),writePrices:async(id,patches)=>{writes++;for(const patch of patches){const row=rows.get(id+':'+patch.code);row.price.price=patch.priceWithVat.price;if(patch.priceWithVat.commonPrice!==undefined)row.price.commonPrice=patch.priceWithVat.commonPrice;if(patch.sales)row.sales.discountCoupon=patch.sales.discountCoupon;}return {outcome:'accepted'};}};
 const proposal={currency:'CZK',tiers:[{name:'First',percent:5,minTurnover:5000}],brandCaps:[],salePolicy:'lowest_price',couponPolicy:'no_loyalty_combination',...overrides};
 const configs=createConfigurationService(db,async()=>true,async()=>true);const draft=await configs.create('101',0,proposal);const approval=await configs.requestApproval('101',draft.revisionId);await configs.approve('101',approval.approvalId,'a'.repeat(64));await configs.apply('101',approval.approvalId);
 const selection={revisionId:draft.revisionId,tierName:'First',targetPricelistId:2,products:[{guid:PRODUCT,codes:['TEST/A','TEST/B']}]};
 const service=createSyncService({db,adapter,assertLiveAllowed:async()=>{}}),runner=createSyncRunner({db,adapterFactory:async()=>adapter,assertLiveAllowed:async()=>{}});
 return {db,adapter,rows,profile,product,proposal,selection,service,runner,get writes(){return writes;},async plan(){return service.plan('101',selection);},async start(mode='dry-run'){const p=await this.plan();if(mode==='live')await service.approve('101',p.approvalId,'a'.repeat(64));return {plan:p,job:await service.execute('101',p.planId,mode,p.approvalId)};}};
}
