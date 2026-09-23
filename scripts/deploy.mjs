const {COOLIFY_APP_WEBHOOK:webhook,COOLIFY_TOKEN:token,PUBLIC_ORIGIN:origin,RELEASE_SHA:sha}=process.env;
if(!webhook||!token||!origin||!sha) throw new Error('Deployment configuration is incomplete');
const request=await fetch(webhook,{method:'POST',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
if(!request.ok) throw new Error(`Coolify rejected deployment (${request.status})`);
for(let attempt=0;attempt<90;attempt++) {
  try {
    const response=await fetch(new URL('/api/health/ready',origin),{signal:AbortSignal.timeout(8000)});
    const state=await response.json();
    if(response.ok&&state.status==='ready'&&state.release===sha) {
      console.log(`Release ${sha} is ready`);process.exit(0);
    }
  } catch {}
  await new Promise(resolve=>setTimeout(resolve,5000));
}
throw new Error('The requested release did not become ready. Check Coolify; the old release is not counted as success.');
