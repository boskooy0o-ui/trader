class Indicators {
  constructor(symbol = 'BTC', initialBalance = 10000) {
    this.symbol = symbol;
    this.candleBuffer = [];
    this.ohlcv = {
      high: [],
      low: [],
      open: [],
      close: [],
      volume: []
    };
    
    // Configurable SuperTrend parameters
    this.fastPeriod = 10;
    this.fastMult = 1.0;
    this.medPeriod = 11;
    this.medMult = 2.0;
    this.slowPeriod = 12;
    this.slowMult = 3.0;

    // Trading Account State
    this.tradingState = {
      symbol: this.symbol,
      long: false,
      short: false,
      position: null, // 'long', 'short', or null
      entryPrice: 0,
      size: 0,
      leverage: 10,
      stopLossPct: 1.5,
      takeProfitPct: 3.0,
      liquidationPrice: 0,
      balance: initialBalance,
      freeMargin: initialBalance,
      usedMargin: 0,
      unrealizedPnl: 0,
      realizedPnl: 0,
      autoTrade: true
    };
  }

  addCandle(candle) {
    this.candleBuffer.push(candle);
    if (this.candleBuffer.length > 500) {
      this.candleBuffer.shift();
    }
    
    this.ohlcv.open.push(candle.open);
    this.ohlcv.high.push(candle.high);
    this.ohlcv.low.push(candle.low);
    this.ohlcv.close.push(candle.close);
    this.ohlcv.volume.push(candle.volume);

    if (this.ohlcv.close.length > 500) {
      this.ohlcv.open.shift();
      this.ohlcv.high.shift();
      this.ohlcv.low.shift();
      this.ohlcv.close.shift();
      this.ohlcv.volume.shift();
    }
  }

  // True Range (TR) & Average True Range (ATR)
  calculateAtr(period) {
    const len = this.ohlcv.close.length;
    if (len < period + 1) return 0;

    let trSum = 0;
    for (let i = len - period; i < len; i++) {
      const high = this.ohlcv.high[i];
      const low = this.ohlcv.low[i];
      const prevClose = this.ohlcv.close[i - 1];
      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trSum += tr;
    }
    return trSum / period;
  }

  // SuperTrend Band & Direction Calculation
  calculateSuperTrend(period, multiplier) {
    const len = this.ohlcv.close.length;
    if (len < period + 1) {
      return { value: 0, trend: 'none' };
    }

    const atr = this.calculateAtr(period);
    const currHigh = this.ohlcv.high[len - 1];
    const currLow = this.ohlcv.low[len - 1];
    const currClose = this.ohlcv.close[len - 1];
    const prevClose = this.ohlcv.close[len - 2];

    const hl2 = (currHigh + currLow) / 2;
    const basicUpperBand = hl2 + multiplier * atr;
    const basicLowerBand = hl2 - multiplier * atr;

    // Determine trend direction
    const isGreen = currClose >= prevClose;
    const trend = isGreen ? 'green' : 'red';
    const value = isGreen ? basicLowerBand : basicUpperBand;

    return { value: Number(value.toFixed(2)), trend };
  }

  getFastSuperTrend() {
    return this.calculateSuperTrend(this.fastPeriod, this.fastMult);
  }

  getMediumSuperTrend() {
    return this.calculateSuperTrend(this.medPeriod, this.medMult);
  }

  getSlowSuperTrend() {
    return this.calculateSuperTrend(this.slowPeriod, this.slowMult);
  }

  // Main 3-Line SuperTrend Signal Evaluator
  evaluateSignals() {
    const fast = this.getFastSuperTrend();
    const med = this.getMediumSuperTrend();
    const slow = this.getSlowSuperTrend();

    const len = this.ohlcv.close.length;
    if (len < 15 || !this.tradingState.autoTrade) return;

    const currentPrice = this.ohlcv.close[len - 1];

    const all3Green = fast.trend === 'green' && med.trend === 'green' && slow.trend === 'green';
    const all3Red = fast.trend === 'red' && med.trend === 'red' && slow.trend === 'red';
    const anyRed = fast.trend === 'red' || med.trend === 'red' || slow.trend === 'red';
    const anyGreen = fast.trend === 'green' || med.trend === 'green' || slow.trend === 'green';

    // Execution Logic
    if (this.tradingState.position === null) {
      if (all3Green) {
        this.openPosition('long', currentPrice);
      } else if (all3Red) {
        this.openPosition('short', currentPrice);
      }
    } else if (this.tradingState.position === 'long' && anyRed) {
      this.closePosition(currentPrice, 'ST_SIGNAL_RED');
    } else if (this.tradingState.position === 'short' && anyGreen) {
      this.closePosition(currentPrice, 'ST_SIGNAL_GREEN');
    }
  }

  openPosition(side, price) {
    const state = this.tradingState;
    if (state.balance <= 0) return;

    const marginToUse = state.balance * 0.4; // Allocates 40% balance
    const positionValue = marginToUse * state.leverage;
    const size = positionValue / price;

    state.position = side;
    state.long = side === 'long';
    state.short = side === 'short';
    state.entryPrice = price;
    state.size = size;
    state.usedMargin = marginToUse;
    state.freeMargin = state.balance - marginToUse;

    // Liquidation Price calculation
    if (side === 'long') {
      state.liquidationPrice = price * (1 - 0.9 / state.leverage);
    } else {
      state.liquidationPrice = price * (1 + 0.9 / state.leverage);
    }
  }

  closePosition(exitPrice, reason) {
    const state = this.tradingState;
    if (!state.position) return;

    const pnl = state.position === 'long'
      ? (exitPrice - state.entryPrice) * state.size
      : (state.entryPrice - exitPrice) * state.size;

    state.balance = Math.max(0, state.balance + pnl);
    state.realizedPnl += pnl;
    state.unrealizedPnl = 0;
    state.freeMargin = state.balance;
    state.usedMargin = 0;
    state.position = null;
    state.long = false;
    state.short = false;
    state.entryPrice = 0;
    state.size = 0;
    state.liquidationPrice = 0;

    console.log(`[${this.symbol}] CLOSED ${reason} at $${exitPrice} | PnL: $${pnl.toFixed(2)} | Balance: $${state.balance.toFixed(2)}`);
  }

  calculateRiskManagement() {
    const len = this.ohlcv.close.length;
    if (len === 0 || !this.tradingState.position) return this.tradingState;

    const currentPrice = this.ohlcv.close[len - 1];
    const state = this.tradingState;

    // Live Unrealized PnL calculation
    if (state.position === 'long') {
      state.unrealizedPnl = (currentPrice - state.entryPrice) * state.size;
    } else if (state.position === 'short') {
      state.unrealizedPnl = (state.entryPrice - currentPrice) * state.size;
    }

    // Stop Loss / Take Profit prices
    const slDist = state.entryPrice * (state.stopLossPct / 100);
    const tpDist = state.entryPrice * (state.takeProfitPct / 100);

    const stopLossPrice = state.position === 'long' ? state.entryPrice - slDist : state.entryPrice + slDist;
    const takeProfitPrice = state.position === 'long' ? state.entryPrice + tpDist : state.entryPrice - tpDist;

    // Risk Triggers
    if (state.position === 'long') {
      if (currentPrice <= state.liquidationPrice) this.closePosition(state.liquidationPrice, 'LIQUIDATION');
      else if (currentPrice <= stopLossPrice) this.closePosition(stopLossPrice, 'STOP_LOSS');
      else if (currentPrice >= takeProfitPrice) this.closePosition(takeProfitPrice, 'TAKE_PROFIT');
    } else if (state.position === 'short') {
      if (currentPrice >= state.liquidationPrice) this.closePosition(state.liquidationPrice, 'LIQUIDATION');
      else if (currentPrice >= stopLossPrice) this.closePosition(stopLossPrice, 'STOP_LOSS');
      else if (currentPrice <= takeProfitPrice) this.closePosition(takeProfitPrice, 'TAKE_PROFIT');
    }

    return this.tradingState;
  }

  update() {
    this.evaluateSignals();
    const state = this.calculateRiskManagement();
    return {
      symbol: this.symbol,
      price: this.ohlcv.close[this.ohlcv.close.length - 1] || 0,
      fastSuperTrend: this.getFastSuperTrend(),
      mediumSuperTrend: this.getMediumSuperTrend(),
      slowSuperTrend: this.getSlowSuperTrend(),
      state
    };
  }
}

module.exports = Indicators;