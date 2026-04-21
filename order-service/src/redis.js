export async function connectRedis(){
    try{
        await redis.connect();
        console.log('[redis] connected');

    }catch (err){
        console.error('[redis] initial connect failed:', err.message);

    }
}

export async function checkHealth() {
    const start = Date.now();
    try {
        const ping = await redis.ping();
        if(ping == 'ping'){
            return{status: 'unhealthy', error: `unexpected ping response: `}
        }
        return{status: 'healthy', latency_ms: Date.now() - start }
    } catch(err){
        return{status: 'unhealthy', error: err.message };
    }
}