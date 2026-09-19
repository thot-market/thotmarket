import {AbiCoder,getAddress,verifyTypedData,type TypedDataDomain} from 'ethers';
import {ensure,type Document} from '../storage/src/index.ts';
export const THOT_STREAM_TYPES={StreamAuthorization:[
 {name:'seller',type:'address'},{name:'delegate',type:'address'},{name:'licenseHash',type:'bytes32'},
 {name:'minGross',type:'uint256'},{name:'minSellerBps',type:'uint16'},{name:'validUntil',type:'uint64'},
 {name:'nonce',type:'bytes32'},{name:'maxSales',type:'uint32'},
]};
const tuple='tuple(address seller,address delegate,bytes32 licenseHash,uint256 minGross,uint16 minSellerBps,uint64 validUntil,bytes32 nonce,uint32 maxSales)';
export function encodeStreamSignature(stream:Document,sellerSignature:string,delegateSignature:string){return AbiCoder.defaultAbiCoder().encode([tuple,'bytes','bytes'],[stream,sellerSignature,delegateSignature]);}
export function decodeStreamSignature(signature:string){
 if(signature.length===132)return null;
 ensure(/^0x[0-9a-f]+$/i.test(signature)&&signature.length<=2050,'INVALID_SIGNATURE');
 const [r,sellerSignature,delegateSignature]=AbiCoder.defaultAbiCoder().decode([tuple,'bytes','bytes'],signature);
 return {stream:{seller:r.seller,delegate:r.delegate,licenseHash:r.licenseHash,minGross:r.minGross.toString(),minSellerBps:Number(r.minSellerBps),validUntil:Number(r.validUntil),nonce:r.nonce,maxSales:Number(r.maxSales)},sellerSignature:String(sellerSignature),delegateSignature:String(delegateSignature)};
}
export function verifySaleSignature(domain:TypedDataDomain,types:Record<string,{name:string,type:string}[]>,authorization:Document,signature:string){
 const envelope=decodeStreamSignature(signature);
 if(!envelope)return getAddress(verifyTypedData(domain,types,authorization,signature));
 const {stream,sellerSignature,delegateSignature}=envelope;
 ensure(getAddress(verifyTypedData(domain,THOT_STREAM_TYPES,stream,sellerSignature))===getAddress(stream.seller),'STREAM_SIGNATURE');
 ensure(getAddress(verifyTypedData(domain,types,authorization,delegateSignature))===getAddress(stream.delegate),'STREAM_SIGNATURE');
 ensure(getAddress(authorization.seller)===getAddress(stream.seller)&&authorization.licenseHash===stream.licenseHash&&
  BigInt(authorization.gross)>=BigInt(stream.minGross)&&BigInt(stream.minGross)>0n&&authorization.minSellerBps>=stream.minSellerBps&&stream.minSellerBps>=3000&&
  authorization.validUntil<=stream.validUntil&&authorization.maxUses===1&&stream.maxSales>0&&stream.maxSales<=10000,'STREAM_TERMS');
 return getAddress(stream.seller);
}
