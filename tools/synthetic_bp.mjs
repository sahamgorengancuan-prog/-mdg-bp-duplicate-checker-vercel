// Deterministic synthetic Indonesian-style BP data for benchmarks/tests.
// Never contains real company data.
export function rng(seed){
  let s=seed>>>0||1;
  return ()=>{s^=s<<13;s>>>=0;s^=s>>>17;s^=s<<5;s>>>=0;return s/4294967296;};
}
const FIRST=['budi','siti','agus','dewi','eko','rina','hendra','wati','joko','sri','andi','yanti','rudi','lina','bambang','ani','dedi','nur','slamet','ratna','teguh','fitri','heri','indah','wahyu','susanti','iwan','mega','yusuf','ayu','ahmad','nining','rahmat','endang','sugeng','tuti','bayu','ika','dimas','putri'];
const LAST=['santoso','wijaya','saputra','lestari','hidayat','pratama','setiawan','kurniawan','susilo','rahayu','nugroho','permana','siregar','nasution','sihombing','hutapea','gunawan','halim','tanjung','harahap','simanjuntak','purba','lubis','sinaga','wibowo','utomo','sutrisno','hartono','irawan','firmansyah'];
const SHOP=['toko','warung','cv','pt','ud','tb','kios','depot','apotek','mini market','grosir','agen','bengkel','salon','laundry'];
const WORD=['maju','jaya','abadi','sejahtera','makmur','sentosa','berkah','mandiri','sumber','rejeki','bersama','indah','baru','lancar','mulia','utama','karya','prima','sehat','sukses','barokah','amanah','cahaya','harapan','mitra'];
const STREET=['raya','merdeka','sudirman','thamrin','diponegoro','gatot subroto','ahmad yani','pemuda','veteran','pahlawan','kartini','imam bonjol','hayam wuruk','gajah mada','cendrawasih','kenanga','melati','mawar','anggrek','flamboyan','cempaka','nusantara','siliwangi','pajajaran','majapahit'];
const KEL=['sukamaju','sukajadi','mekarsari','karanganyar','sidomulyo','tegalrejo','cibubur','kebayoran','cilandak','pasar minggu','tanjung priok','bojong','cimahi','ciputat','pamulang','serpong','bekasi jaya','harapan baru','margahayu','rancaekek'];
const KEC=['cibinong','bojonggede','cileungsi','gunung putri','citeureup','sukaraja','ciawi','cisarua','megamendung','babakan madang','kemang','parung','ciseeng','tajurhalang','kelapa dua','ciledug','karawaci','cipondoh','batuceper','neglasari'];
const CITY=['kab bogor','kota bogor','kota depok','kota bekasi','kab bekasi','kota tangerang','kab tangerang','jakarta selatan','jakarta timur','jakarta barat','jakarta utara','kota bandung','kab bandung','kota semarang','kota surabaya','kab sidoarjo','kota medan','kab deli serdang','kota makassar','kota palembang'];
const SYL=['ba','bu','di','ka','ko','ma','mu','na','ni','pra','ra','ri','sa','se','si','ta','tu','wa','wi','ya','ha','ja','jo','la','li','ga','gu','da','de','nu','po','pe','ro','ru','so','su','te','ti','yo','ze','an','in','ur','ok','em'];
const pick=(r,a)=>a[Math.floor(r()*a.length)];
// Large realistic vocabulary: syllable words (~90k distinct) like real names.
const word=r=>{let w='';const n=2+Math.floor(r()*2);for(let i=0;i<n;i++)w+=pick(r,SYL);return w+(r()<0.3?pick(r,['n','r','s','t','ng','k']):'');};
const pad=(n,w)=>String(n).padStart(w,'0');
export function makeRecord(r,i){
  const person=(r()<0.5?pick(r,FIRST):word(r))+' '+(r()<0.5?pick(r,LAST):word(r));
  const name=(r()<0.55?pick(r,SHOP)+' '+(r()<0.5?pick(r,WORD):word(r))+' '+pick(r,WORD):person).toUpperCase();
  const address=('jl '+(r()<0.6?pick(r,STREET):word(r))+(r()<0.4?' gg '+pick(r,WORD):'')+' no '+Math.floor(r()*250+1)+
    ' rt '+pad(Math.floor(r()*20+1),3)+' rw '+pad(Math.floor(r()*15+1),3)+
    ' kel '+(r()<0.5?pick(r,KEL):word(r))+' kec '+pick(r,KEC)+' '+pick(r,CITY)+(r()<0.3?' '+person:'')).toUpperCase();
  const ktp=r()<0.78?String(3100000000000000+Math.floor(r()*899999999999999)):'';
  return {bp_id:String(110000000+i),bp_type_id:r()<0.8?'ZB02':'ZB03',name_1:name,address,ktp};
}
export function makeTsv(count,seed=7){
  const r=rng(seed),lines=['bp_id\tbp_type_id\tname_1\taddress\tktp_digits'],records=[];
  for(let i=0;i<count;i++){
    const x=makeRecord(r,i);records.push(x);
    lines.push([x.bp_id,x.bp_type_id,x.name_1,x.address,x.ktp].join('\t'));
  }
  return {tsv:Buffer.from(lines.join('\n'),'utf8'),records};
}
// Typo / word-drop / digit changes of an existing record.
export function perturb(r,x){
  let name=x.name_1,address=x.address;
  const ops=Math.floor(r()*3)+1;
  for(let k=0;k<ops;k++){
    const op=Math.floor(r()*4);
    if(op===0&&name.length>3){const p=Math.floor(r()*name.length);name=name.slice(0,p)+name.slice(p+1);}
    else if(op===1){const w=address.split(' ');if(w.length>4)w.splice(Math.floor(r()*w.length),1);address=w.join(' ');}
    else if(op===2){address=address.replace(/\d/,d=>String((Number(d)+1)%10));}
    else {const p=Math.floor(r()*address.length);address=address.slice(0,p)+'X'+address.slice(p+1);}
  }
  return {name_1:name,address};
}
