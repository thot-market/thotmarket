import {createTeeRecorder} from '../packages/capture/src/tee/server.ts';
import {authorizationOrigins,authorizeCapture} from '../packages/capture/src/tee/authorization.ts';
const thots=authorizationOrigins(process.env.THOT_AUTH_ORIGINS??JSON.stringify([process.env.THOT_AUTH_ORIGIN]));
const server=await createTeeRecorder({authorize:capture=>authorizeCapture(thots,capture)});
server.listen(Number(process.env.PORT??4321),'0.0.0.0',()=>console.log('TEE recorder ready'));
