import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
const fail=()=>{throw Error('INVALID_PRIVATE_R2_CONFIGURATION');};
const check=value=>{if(!value)fail();};
const names=['THOT_S3_ENDPOINT','THOT_S3_REGION','THOT_S3_BUCKET','THOT_S3_PREFIX','THOT_STORAGE_NAMESPACE','THOT_S3_ACCESS_KEY_ID','THOT_S3_SECRET_ACCESS_KEY'];
async function privateText(path){
  check(typeof path==='string'&&isAbsolute(path));let file;
  try{file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const st=await file.stat();check(st.isFile()&&st.nlink===1&&st.uid===process.getuid()&&(st.mode&0o777)===0o600&&st.size<=16384);return await file.readFile('utf8');}finally{await file?.close();}
}
export function parseR2Dotenv(text){
  const env={};for(const raw of text.split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#'))continue;
    const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);check(match&&!Object.hasOwn(env,match[1]));let value=match[2].trim();
    if(value.startsWith('"')||value.startsWith("'")){check(value.length>=2&&value.endsWith(value[0]));value=value.slice(1,-1);}
    check(!/[\r\n\x00$`\\]/.test(value));env[match[1]]=value;
  }
  return env;
}
/** Only sealed.env contains identifiers or credentials; Compose holds variable references. */
export async function renderPrivateR2(config,volume){
  if(config===undefined)return {environment:'',service:'',volumes:'',sealedEnv:''};
  check(config&&Object.keys(config).every(key=>['target','credentials_path','quota_password_path','quota_image','initialize'].includes(key)));
  check(['dev','staging','prod'].includes(config.target));check(/^[a-z][a-z0-9_-]{0,62}$/.test(volume));
  check(/^postgres:[a-zA-Z0-9._-]+@sha256:[a-f0-9]{64}$/.test(config.quota_image));
  check(config.initialize===undefined||typeof config.initialize==='boolean');
  const env=parseR2Dotenv(await privateText(config.credentials_path));
  check(names.every(name=>typeof env[name]==='string'&&env[name].length>0));
  check(env.THOT_STORAGE_NAMESPACE===config.target&&env.THOT_S3_REGION==='auto');
  check(/^https:\/\/[a-f0-9]{32}(?:\.(?:eu|fedramp))?\.r2\.cloudflarestorage\.com\/?$/.test(env.THOT_S3_ENDPOINT));
  check(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(env.THOT_S3_BUCKET));
  check(/^(?:[a-zA-Z0-9_-]+\/)+$/.test(env.THOT_S3_PREFIX));
  check(/^[a-zA-Z0-9_-]{16,256}$/.test(env.THOT_S3_ACCESS_KEY_ID)&&/^[a-zA-Z0-9_+\/=.-]{16,256}$/.test(env.THOT_S3_SECRET_ACCESS_KEY));
  const password=(await privateText(config.quota_password_path)).trim();check(/^[a-zA-Z0-9_-]{32,128}$/.test(password));
  const initialize=config.initialize===true?'true':'';
  const environment='      THOT_OBJECT_STORAGE: "s3"\n'+names.map(name=>`      ${name.replace('THOT_','THOT_')}: "\${${name}:?sealed R2 configuration}"`).join('\n')+`\n      THOT_QUOTA_DATABASE_URL: "\${THOT_QUOTA_DATABASE_URL:?CVM-local quota database}"\n`+(initialize?'      THOT_REMOTE_STORAGE_INITIALIZE: "true"\n':'')+'    depends_on:\n      thot-quota:\n        condition: service_healthy';
  const service=`  thot-quota:
    image: "${config.quota_image}"
    restart: unless-stopped
    mem_limit: 256m
    pids_limit: 80
    environment:
      POSTGRES_USER: "thot_quota"
      POSTGRES_DB: "thot_quota"
      POSTGRES_PASSWORD: "\${THOT_QUOTA_DATABASE_PASSWORD:?sealed quota password}"
    command: ["postgres", "-c", "shared_buffers=32MB", "-c", "max_connections=20"]
    volumes:
      - ${volume}-quota:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U thot_quota -d thot_quota"]
      interval: 5s
      timeout: 3s
      retries: 20
    cap_drop: [NET_RAW]
    security_opt: ["no-new-privileges:true"]
`;
  return {environment,service,volumes:`  ${volume}-quota: {}`,sealedEnv:names.map(name=>`${name}=${env[name]}\n`).join('')+`THOT_QUOTA_DATABASE_PASSWORD=${password}\nTHOT_QUOTA_DATABASE_URL=postgresql://thot_quota:${password}@thot-quota:5432/thot_quota\n`};
}

/** Preserve a reviewed running Anvil composition; only add storage to its app. */
export async function wirePrivateAnvilR2(compose,config,quotaVolume){
  check(typeof compose==='string'&&!compose.includes('THOT_OBJECT_STORAGE:')&&!compose.includes('  thot-quota:'));
  check(/^[a-z][a-z0-9_-]{0,62}$/.test(quotaVolume));
  const start=compose.indexOf('\n  private-anvil-app:\n');check(start>=0);
  const next=/\n  [A-Za-z0-9_-]+:\n|\nvolumes:\n/.exec(compose.slice(start+3));check(next);const end=start+3+next.index;
  const app=compose.slice(start,end);check(/^    network_mode: (?:service:private-anvil|"service:private-anvil"|'service:private-anvil')\s*$/m.test(app));
  check(app.includes('    environment:\n')&&app.includes('    depends_on:\n'));
  const remote=await renderPrivateR2(config,quotaVolume);
  const environment=remote.environment.split('    depends_on:\n')[0];
  const updated=app.replace('    environment:\n','    environment:\n'+environment+'\n').replace('    depends_on:\n','    depends_on:\n      thot-quota: {condition: service_healthy}\n');
  let result=compose.slice(0,start)+updated+compose.slice(end);
  const marker='\nvolumes:\n',index=result.indexOf(marker);check(index>=0&&result.indexOf(marker,index+1)<0);
  const service=remote.service.replace('    restart:','    network_mode: "service:private-anvil"\n    depends_on: [private-anvil]\n    restart:').replace('"max_connections=20"]','"max_connections=20", "-c", "listen_addresses=127.0.0.1"]');
  result=result.slice(0,index)+'\n'+service+result.slice(index)+remote.volumes+'\n';
  return {compose:result,sealedEnv:remote.sealedEnv.replace('@thot-quota:5432/','@127.0.0.1:5432/')};
}
