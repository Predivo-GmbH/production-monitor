import fs from 'node:fs'
const LOG='C:/Users/roger_rwjnmnz/AppData/Local/Temp/gated-prod.log'
const log=m=>fs.appendFileSync(LOG,new Date().toISOString().slice(11,19)+' '+m+'\n')
const rows=fs.readFileSync('C:/Users/roger_rwjnmnz/AppData/Local/Temp/live.tsv','utf8').trim().split('\n').map(l=>l.split('\t'))
const staging=rows.filter(r=>/staging/i.test(r[1]))
const prod=rows.filter(r=>!/staging/i.test(r[1]))
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const state=async([ref,name,pat])=>{
  const H={Authorization:`Bearer ${pat}`}
  const p=await (await fetch(`https://api.supabase.com/v1/projects/${ref}`,{headers:H})).json().catch(()=>({}))
  const e=await (await fetch(`https://api.supabase.com/v1/projects/${ref}/upgrade/eligibility`,{headers:H})).json().catch(()=>({}))
  return {name,status:p.status,version:String(e.current_app_version||'').replace('supabase-postgres-','')}
}
fs.writeFileSync(LOG,'gate started\n')
let ok=0
for(let i=0;i<80;i++){
  const s=await Promise.all(staging.map(state))
  ok=s.filter(x=>x.status==='ACTIVE_HEALTHY'&&x.version==='17.6.1.166').length
  const broken=s.filter(x=>x.status&&!['ACTIVE_HEALTHY','UPGRADING','COMING_UP','RESTORING'].includes(x.status))
  log(`staging healthy-on-new-build ${ok}/${staging.length}` + (broken.length?` BROKEN: ${broken.map(b=>b.name+'='+b.status).join(', ')}`:''))
  if(broken.length){ log('GATE FAILED — a staging machine is not healthy. Production NOT touched.'); process.exit(1) }
  if(ok===staging.length) break
  await sleep(30000)
}
if(ok!==staging.length){ log(`GATE TIMED OUT at ${ok}/${staging.length}. Production NOT touched.`); process.exit(1) }
log('GATE PASSED — all staging healthy on 17.6.1.166. Starting production upgrades.')
for(const [ref,name,pat] of prod){
  const H={Authorization:`Bearer ${pat}`,'Content-Type':'application/json'}
  const e=await (await fetch(`https://api.supabase.com/v1/projects/${ref}/upgrade/eligibility`,{headers:{Authorization:H.Authorization}})).json().catch(()=>({}))
  if(e.current_app_version===e.latest_app_version){ log(`${name}: already current`); continue }
  if(!e.eligible){ log(`${name}: NOT ELIGIBLE, skipped`); continue }
  const r=await fetch(`https://api.supabase.com/v1/projects/${ref}/upgrade`,{method:'POST',headers:H,body:JSON.stringify({release_channel:'ga',target_version:'17'})})
  const j=await r.json().catch(()=>({}))
  log(`${name}: ${r.status===201?'UPGRADE STARTED '+(j.tracking_id||'').slice(0,8):'FAILED '+r.status+' '+JSON.stringify(j).slice(0,60)}`)
  await sleep(5000)
}
log('all production upgrades issued; verifying')
for(let i=0;i<80;i++){
  const s=await Promise.all(prod.map(state))
  const good=s.filter(x=>x.status==='ACTIVE_HEALTHY'&&x.version==='17.6.1.166').length
  log(`production healthy-on-new-build ${good}/${prod.length}`)
  if(good===prod.length){ log('ALL PRODUCTION ON CURRENT BUILD'); break }
  await sleep(30000)
}
log('DONE')
