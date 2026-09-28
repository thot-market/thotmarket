// Operator log access without exposing container configuration, identical on every target.
// thot-log-filter holds the read-only Docker socket and forwards only container listing and log
// reads; inspect (which returns sealed environment values), exec, stats and every write are
// refused. thot-log-gate publishes port 4330 and forwards to it only with the sealed bearer token
// THOT_LOG_TOKEN; it has no socket. Read with scripts/cvm-logs.mjs.
export const logFilterName='thot-log-filter',logGateName='thot-log-gate',logPort=4330;
const logging={driver:'json-file',options:{'max-size':'20m','max-file':'3'}};
const hardened={restart:'unless-stopped',logging,read_only:true,mem_limit:'64m',pids_limit:32,
  tmpfs:['/config:rw,noexec,nosuid,nodev,size=8m','/data:rw,noexec,nosuid,nodev,size=8m','/tmp:rw,noexec,nosuid,nodev,size=2m']};
// Caddy's default error log records the full request URI (e.g. /rpc/<token>) when an upstream fails.
export const quietErrors=['  log default {','    exclude http.log.error','  }'];
export const printfArgs=lines=>lines.map(line=>`'${line}'`).join(' ');
const caddy=(lines,guard='')=>['sh','-c',`${guard}printf '%s\\n' ${printfArgs(['{','  admin off','  auto_https off',...quietErrors,'}',...lines])} > /tmp/Caddyfile && exec caddy run --config /tmp/Caddyfile`];
export const logFilterService=image=>({image,...hardened,volumes:['/var/run/docker.sock:/var/run/docker.sock:ro'],command:caddy([':2375 {','  @logs_only {','    method GET HEAD',
  '    path_regexp ^/(v[0-9.]+/)?(_ping|containers/json|containers/[a-zA-Z0-9_.-]+/logs)$$','  }',
  '  handle @logs_only {','    reverse_proxy unix//var/run/docker.sock','  }','  handle {','    respond 403','  }','}'])});
export const logGateService=image=>({image,...hardened,ports:[`${logPort}:${logPort}`],depends_on:[logFilterName],
  environment:{THOT_LOG_TOKEN:'${THOT_LOG_TOKEN:?sealed log access token}'},
  command:caddy([`:${logPort} {`,'  @token header Authorization "Bearer {$$THOT_LOG_TOKEN}"','  handle @token {',
    `    reverse_proxy ${logFilterName}:2375 {`,'      flush_interval -1','    }','  }','  handle {','    respond 401','  }','}'],
    '[ $${#THOT_LOG_TOKEN} -ge 32 ] || { echo THOT_LOG_TOKEN_TOO_SHORT >&2; exit 1; }; ')});
