const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const Indicators = require('./indicators');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const symbols = ['BTC', 'ETH', 'SOL', 'BNB'];
const indicators = {};
const prices = { BTC: 68000, ETH: 3500, SOL: 180, BNB: 600 };

// Initialize an isolated Indicators engine instance for each coin
symbols.forEach(sym => {
  indicators[sym] = new Indicators(sym, 10000);
});

// Uptime keep-alive endpoint for cloud hosting (Render)
app.get('/ping', (req, res) => {
  res.send('OK');
});

// REST API endpoint for system status check
app.get('/api/status', (req, res) => {
  const status = {};
  symbols.forEach(sym => {
    status[sym] = indicators[sym].update();
  });
  res.json(status);
});

// WebSocket Connection Management
wss.on('connection', (ws) => {
  console.log('Mobile client connected via WebSocket.');

  ws.on('message', (msgStr) => {
    try {
      const msg = JSON.parse(msgStr);
      // Allows changing settings (leverage, autoTrade, etc.) over WebSocket
      if (msg.type === 'UPDATE_CONFIG' && msg.symbol && indicators[msg.symbol]) {
        Object.assign(indicators[msg.symbol].tradingState, msg.config);
      }
    } catch (e) {
      console.error('WebSocket message parsing error:', e.message);
    }
  });

  // Broadcast initial full snapshot on connection
  const snapshot = {};
  symbols.forEach(sym => {
    snapshot[sym] = indicators[sym].update();
  });
  ws.send(JSON.stringify({ type: 'SNAPSHOT', data: snapshot }));
});

// 1-Second Tick Loop (Generates realistic 1m OHLCV candles)
setInterval(() => {
  const updates = {};

  symbols.forEach(sym => {
    // Geometric Brownian motion tick simulation
    const volatility = 0.0012;
    const changePct = (Math.random() - 0.495) * volatility;
    prices[sym] = Number((prices[sym] * (1 + changePct)).toFixed(2));

    const currentPrice = prices[sym];
    const candle = {
      open: currentPrice,
      high: Number((currentPrice * 1.0005).toFixed(2)),
      low: Number((currentPrice * 0.9995).toFixed(2)),
      close: currentPrice,
      volume: Number((Math.random() * 50).toFixed(2))
    };

    indicators[sym].addCandle(candle);
    updates[sym] = indicators[sym].update();
  });

  // Broadcast market and strategy state to all connected clients
  const payload = JSON.stringify({ type: 'TICK', data: updates });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}, 1000);

// Bind to PORT provided by host environment or fallback to 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`24/7 SuperTrend Trading Engine running on port ${PORT}`);
});