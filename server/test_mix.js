const io = require('socket.io-client');
const http = require('http');

const socket = io('http://localhost:3000');

socket.on('connect', () => {
    console.log('Connected to server via WebSocket');
    
    // Trigger the test
    const payload = JSON.stringify({
        mode: 'simultaneous',
        recipe_name: 'Test Auto 100ml',
        N_ml: 100, P_ml: 100, K_ml: 100,
        water_l: 30
    });

    const options = {
        hostname: 'localhost',
        port: 3000,
        path: '/api/start',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload)
        }
    };

    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            console.log('API Response:', data);
        });
    });

    req.on('error', (e) => {
        console.error(`Problem with request: ${e.message}`);
    });

    req.write(payload);
    req.end();
});

let startTime = Date.now();

socket.on('stats', (data) => {
    // Print the flow rates
    console.log(`[${Math.round((Date.now() - startTime)/1000)}s] Flow (LPM): N=${data.flow_n}, P=${data.flow_p}, K=${data.flow_k} | Steps: N=${data.step_n}, P=${data.step_p}, K=${data.step_k}`);
});

socket.on('stop_cycle', () => {
    console.log('Cycle finished!');
    process.exit(0);
});

setTimeout(() => {
    console.log('Timeout reached. Exiting.');
    process.exit(0);
}, 120000); // Wait up to 2 mins
