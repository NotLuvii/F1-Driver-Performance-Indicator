const express = require('express');
const path = require('path');
const httpProxy = require('http-proxy');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

const API_BASE_URL = 'https://api.openf1.org/v1/';
const app = express();
const proxy = httpProxy.createProxyServer({
    target: 'https://api.openf1.org/v1',
    changeOrigin: true,
    logLevel: 'debug', // Detailed logging
});

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/src', express.static(path.join(__dirname, 'src'))); // Serve static files from 'src' directory

app.use('/api', createProxyMiddleware({
    target: API_BASE_URL,
    changeOrigin: true,
    pathRewrite: {
        '^/api': '',
    },
    onProxyReq: (proxyReq, req, res) => {
        console.log(`Proxying request to: ${API_BASE_URL}${req.url}`);
    },
    onError: (err, req, res) => {
        console.error('Proxy error:', err);
        res.status(500).send('Proxy error');
    },
}));

const PORT = 8000;
app.listen(PORT, () => {
    console.log(`Proxy server running on http://localhost:${PORT}`);
});
