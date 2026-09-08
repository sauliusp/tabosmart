import QRCode from 'qrcode';
import fs from 'node:fs/promises';
const url='https://tabosmart.featurebase.app/';
const options={errorCorrectionLevel:'M',margin:4,color:{dark:'#183c35',light:'#ffffff'}};
await fs.mkdir('marketing/community-launch/feedback',{recursive:true});
const svg=await QRCode.toString(url,{...options,type:'svg'});
for(const file of ['marketing/community-launch/feedback/feedback-qr.svg','extension/icons/feedback-qr.svg','website/public/feedback-qr.svg']) await fs.writeFile(file,svg);
await QRCode.toFile('marketing/community-launch/feedback/feedback-qr.png',url,{...options,width:592});
console.log('Static QR generated with a four-module quiet zone. Destination:',url);
