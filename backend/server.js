#!/usr/bin/env node

/**
 * Token Dashboard - REST API Server
 * 啟動：node backend/server.js
 * 訪問：http://localhost:3737
 */

const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const { calculateCost } = require('./utils/pricing');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3737;
const DB_PATH = path.join(__dirname, 'db/openclaw-tokens.db');
const OPENCLAW_CONFIG_PATH = path.join(require('os').homedir(), '.openclaw/openclaw.json');

// 快取機制
let openclawCache = {
  data: null,
  timestamp: null,
  ttl: 30000 // 30 秒快取
};

// 更新快取
async function updateOpenclawCache() {
  try {
    const data = await parseOpenclawModels();
    openclawCache.data = data;
    openclawCache.timestamp = Date.now();
    console.log('✅ OpenClaw 快取已更新');
  } catch (error) {
    console.error('更新快取失敗:', error.message);
  }
}

// 獲取快取數據（過期則更新）
async function getOpenclawData() {
  const now = Date.now();
  if (!openclawCache.data || (now - openclawCache.timestamp) > openclawCache.ttl) {
    await updateOpenclawCache();
  }
  return openclawCache.data || { defaultModel: 'unknown', models: {} };
}

// 數據收集器：每 5 分鐘收集一次使用統計（不消耗 LLM token）
async function collectUsageData() {
  try {
    console.log('📊 開始收集使用數據...');
    
    // 讀取 sessions.json
    const sessionsPath = path.join(require('os').homedir(), '.openclaw/agents/main/sessions/sessions.json');
    
    if (!fs.existsSync(sessionsPath)) {
      console.warn('⚠️ sessions.json 不存在');
      return;
    }
    
    const sessionsData = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    const sessions = Object.values(sessionsData);
    
    console.log(`📋 找到 ${sessions.length} 個 sessions`);
    
    // 累積統計 - 只統計最近 6 小時的更新
    const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);
    let totalTokens = 0;
    const modelUsage = {};
    let skipped = { tooOld: 0, noTokens: 0 };
    
    sessions.forEach(session => {
      if (!session.updatedAt || session.updatedAt < sixHoursAgo) {
        skipped.tooOld++;
        return;
      }
      if (!session.totalTokens || session.totalTokens === 0) {
        skipped.noTokens++;
        return;
      }
      
      totalTokens += session.totalTokens;
      
      const model = session.model || 'unknown';
      if (!modelUsage[model]) {
        modelUsage[model] = { tokens: 0, sessions: 0 };
      }
      modelUsage[model].tokens += session.totalTokens;
      modelUsage[model].sessions += 1;
    });
    
    console.log(`⏭️  跳過：${skipped.tooOld} 個過舊，${skipped.noTokens} 個無 token`);
    
    if (totalTokens === 0) {
      console.log('⚠️ 無新數據，跳過此次收集');
      return;
    }
    
    // 寫入資料庫（按模型分組）
    const db = getDb();
    const timestamp = new Date().toISOString();
    let inserted = 0;
    const modelCount = Object.keys(modelUsage).length;
    
    for (const [modelName, stats] of Object.entries(modelUsage)) {
      const [provider, ...modelParts] = modelName.split('/');
      const model = modelParts.join('/') || modelName;
      
      // 簡單估算：假設 input:output = 1:2
      const inputTokens = Math.floor(stats.tokens / 3);
      const outputTokens = stats.tokens - inputTokens;
      
      db.run(`
        INSERT INTO token_usage 
        (provider, model, input_tokens, output_tokens, event_type, event_description, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [provider, model, inputTokens, outputTokens, 'auto_collect', `自動收集 (${stats.sessions} sessions)`, timestamp], (err) => {
        if (err) {
          console.error(`寫入 ${modelName} 數據失敗:`, err.message);
        }
        inserted++;
        if (inserted === modelCount) {
          console.log(`✅ 數據已收集：總計 ${totalTokens} tokens (${modelCount} 模型)`);
          db.close();
        }
      });
    }
    
    if (modelCount === 0) {
      db.close();
    }
    
    // 收集 Rate Limit 資訊
    await collectRateLimitData();
    
  } catch (error) {
    console.error('收集數據失敗:', error.message);
  }
}

// Rate Limit 數據收集器
async function collectRateLimitData() {
  try {
    const { stdout } = await execAsync('openclaw models 2>/dev/null || echo ""');
    const lines = stdout.split('\n');
    
    const db = getDb();
    const timestamp = new Date().toISOString();
    let collected = 0;
    
    lines.forEach(line => {
      // 解析 cooldown：「google:default=... [cooldown 46m]」
      const cooldownMatch = line.match(/([\w-]+):[\w.-]+=.+\[cooldown\s+(\d+)([mh])\]/);
      if (cooldownMatch) {
        const [, provider, time, unit] = cooldownMatch;
        const cooldownMinutes = unit === 'h' ? parseInt(time) * 60 : parseInt(time);
        const cooldownUntil = new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString();
        
        db.run(`
          INSERT INTO rate_limits (provider, cooldown_until, timestamp)
          VALUES (?, ?, ?)
        `, [provider, cooldownUntil, timestamp], (err) => {
          if (!err) collected++;
        });
      }
    });
    
    if (collected > 0) {
      console.log(`✅ Rate Limit 數據已收集：${collected} 筆`);
    }
    
    db.close();
  } catch (error) {
    console.error('收集 Rate Limit 失敗:', error.message);
  }
}

// 中間件
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// 資料庫連線
function getDb() {
  return new sqlite3.Database(DB_PATH);
}

// 執行 openclaw models 命令並解析輸出
async function parseOpenclawModels() {
  try {
    const { stdout } = await execAsync('openclaw models 2>/dev/null || echo ""');
    const lines = stdout.split('\n').filter(l => l.trim());
    
    let defaultModel = 'unknown';
    let models = {};
    let configuredModels = [];
    let fallbackModels = [];
    
    // 查找 Default 行：「Default       : anthropic/claude-haiku-4-5」
    const defaultLine = lines.find(l => l.includes('Default'));
    if (defaultLine) {
      const match = defaultLine.match(/:\s*([\w\-/\.]+)/);
      if (match) defaultModel = match[1];
    }
    
    // 解析 Configured models
    const configuredLine = lines.find(l => l.startsWith('Configured models'));
    if (configuredLine) {
      const modelsStr = configuredLine.split(':')[1];
      if (modelsStr) {
        configuredModels = modelsStr.split(',').map(m => m.trim()).filter(m => m);
      }
    }
    
    // 解析 Fallbacks
    const fallbacksLine = lines.find(l => l.startsWith('Fallbacks'));
    if (fallbacksLine) {
      const modelsStr = fallbacksLine.match(/:\s*(.+)$/);
      if (modelsStr && modelsStr[1]) {
        fallbackModels = modelsStr[1].split(',').map(m => m.trim()).filter(m => m);
      }
    }
    
    // 查找 OAuth/token status 區塊
    let inOAuthSection = false;
    let currentProvider = null;
    
    lines.forEach(line => {
      if (line.includes('OAuth/token status')) {
        inOAuthSection = true;
        return;
      }
      
      if (!inOAuthSection) return;
      
      // Provider 行：「- google-antigravity」
      if (line.match(/^- ([\w\-]+)$/)) {
        currentProvider = line.match(/^- ([\w\-]+)$/)[1];
        if (!models[currentProvider]) {
          models[currentProvider] = [];
        }
        return;
      }
      
      // 配額行：「- google-gemini-cli usage: Pro 100% left · Flash 100% left」
      if (line.match(/usage:/) && currentProvider) {
        const parts = line.split('·');
        parts.forEach(part => {
          const quotaMatch = part.match(/(\w+)\s+(\d+)%/);
          if (quotaMatch) {
            const [, modelName, quota] = quotaMatch;
            if (!models[currentProvider]) {
              models[currentProvider] = [];
            }
            models[currentProvider].push({
              profile: `${currentProvider}:${modelName}`,
              quota: parseInt(quota),
              status: 'ok',
              full_name: `${currentProvider}/${modelName}`
            });
          }
        });
      }
      
      // Static profile 行：「  - anthropic:default static」
      if (currentProvider && line.match(/^\s+-\s+([\w:.-]+)\s+static/i)) {
        const profileMatch = line.match(/^\s+-\s+([\w:.-]+)\s+static/i);
        if (profileMatch) {
          const [, profile] = profileMatch;
          models[currentProvider].push({
            profile,
            status: 'ok',
            authType: 'static',
            full_name: `${currentProvider}/${profile}`
          });
        }
        return;
      }
      
      // OAuth 帳戶行：「  - profile_name (email@example.com) ok expires in 55m」
      if (currentProvider && line.match(/^\s+-\s+([\w:.-]+)\s+\(.*?\)\s+(ok|expired)/)) {
        const profileMatch = line.match(/^\s+-\s+([\w:.-]+)\s+\((.*?)\)\s+(ok|expired)/);
        if (profileMatch) {
          const [, profile, email, status] = profileMatch;
          models[currentProvider].push({
            profile,
            email,
            status,
            authType: 'oauth',
            full_name: `${currentProvider}/${profile}`
          });
        }
      }
    });
    
    return { defaultModel, models, configuredModels, fallbackModels, raw: stdout };
  } catch (error) {
    console.error('執行 openclaw models 失敗:', error.message);
    return { defaultModel: 'unknown', models: {}, raw: '' };
  }
}

// API: 總覽統計
app.get('/api/overview', (req, res) => {
  const db = getDb();
  const { period = 'today' } = req.query;
  
  let timeFilter = '';
  switch (period) {
    case 'today':
      timeFilter = "AND date(timestamp) = date('now')";
      break;
    case 'week':
      timeFilter = "AND timestamp >= datetime('now', '-7 days')";
      break;
    case 'month':
      timeFilter = "AND timestamp >= datetime('now', '-30 days')";
      break;
  }
  
  db.get(`
    SELECT 
      SUM(input_tokens) as total_tokens_in,
      SUM(output_tokens) as total_tokens_out,
      COUNT(*) as total_requests,
      GROUP_CONCAT(DISTINCT model) as models_used
    FROM token_usage
    WHERE 1=1 ${timeFilter}
  `, (err, row) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    const totalTokens = (row.total_tokens_in || 0) + (row.total_tokens_out || 0);
    const cost = calculateCost('claude-sonnet-4-5', row.total_tokens_in || 0, row.total_tokens_out || 0);
    
    res.json({
      period,
      total_tokens: totalTokens,
      total_tokens_in: row.total_tokens_in || 0,
      total_tokens_out: row.total_tokens_out || 0,
      total_requests: row.total_requests || 0,
      estimated_cost: cost,
      models_used: row.models_used ? row.models_used.split(',') : []
    });
  });
  
  db.close();
});

// API: 模型配額狀態（從快取讀取）
app.get('/api/models', async (req, res) => {
  try {
    const openclawData = await getOpenclawData();
    
    // 整合 configured + fallback 模型，生成完整的可切換模型列表
    const allAvailableModels = [
      ...(openclawData.configuredModels || []),
      ...(openclawData.fallbackModels || [])
    ];
    
    // 構建模型列表（帶狀態）
    const models = allAvailableModels.map(fullName => {
      const [provider, ...modelParts] = fullName.split('/');
      const modelName = modelParts.join('/');
      const isCurrent = fullName === openclawData.defaultModel;
      const isConfigured = (openclawData.configuredModels || []).includes(fullName);
      
      return {
        full_name: fullName,
        provider,
        model: modelName,
        is_current: isCurrent,
        is_configured: isConfigured,
        is_fallback: !isConfigured,
        status: 'available'
      };
    });
    
    res.json({
      current_model: openclawData.defaultModel,
      models,
      providers: openclawData.models, // 保留 OAuth/token status
      cache_age: openclawCache.timestamp ? Date.now() - openclawCache.timestamp : null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('獲取模型列表失敗:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: Rate Limits 狀態
app.get('/api/rate-limits', (req, res) => {
  const db = getDb();
  
  // 取得最新的 rate limit 記錄
  db.all(`
    SELECT 
      rl1.provider,
      rl1.rpm_current,
      rl1.rpm_limit,
      rl1.tpm_current,
      rl1.tpm_limit,
      rl1.cooldown_until,
      rl1.timestamp,
      rl1.metadata
    FROM rate_limits rl1
    INNER JOIN (
      SELECT provider, MAX(timestamp) as max_timestamp
      FROM rate_limits
      GROUP BY provider
    ) rl2
    ON rl1.provider = rl2.provider 
    AND rl1.timestamp = rl2.max_timestamp
    ORDER BY rl1.provider
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    res.json({
      rate_limits: rows.map(row => ({
        provider: row.provider,
        rpm: row.rpm_current ? `${row.rpm_current}/${row.rpm_limit}` : 'N/A',
        tpm: row.tpm_current ? `${row.tpm_current}/${row.tpm_limit}` : 'N/A',
        cooldown_until: row.cooldown_until,
        timestamp: row.timestamp,
        metadata: row.metadata ? JSON.parse(row.metadata) : {}
      }))
    });
  });
  
  db.close();
});

// API: 歷史趨勢
app.get('/api/history', (req, res) => {
  const db = getDb();
  const { days = 7 } = req.query;
  
  db.all(`
    SELECT 
      date(timestamp) as date,
      SUM(input_tokens) as total_tokens_in,
      SUM(output_tokens) as total_tokens_out,
      COUNT(*) as requests
    FROM token_usage
    WHERE timestamp >= datetime('now', '-${parseInt(days)} days')
    GROUP BY date(timestamp)
    ORDER BY date DESC
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    const history = rows.map(row => ({
      date: row.date,
      total_tokens: (row.total_tokens_in || 0) + (row.total_tokens_out || 0),
      tokens_in: row.total_tokens_in || 0,
      tokens_out: row.total_tokens_out || 0,
      requests: row.requests || 0
    }));
    
    res.json({ history });
  });
  
  db.close();
});

// API: 成本估算
app.get('/api/cost', (req, res) => {
  const db = getDb();
  const { period = 'month' } = req.query;
  
  let timeFilter = '';
  switch (period) {
    case 'today':
      timeFilter = "AND date(timestamp) = date('now')";
      break;
    case 'week':
      timeFilter = "AND timestamp >= datetime('now', '-7 days')";
      break;
    case 'month':
      timeFilter = "AND timestamp >= datetime('now', '-30 days')";
      break;
  }
  
  db.all(`
    SELECT 
      model,
      SUM(input_tokens) as total_tokens_in,
      SUM(output_tokens) as total_tokens_out
    FROM token_usage
    WHERE 1=1 ${timeFilter}
    GROUP BY model
  `, (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
      return;
    }
    
    let totalCost = 0;
    const breakdown = rows.map(row => {
      const cost = calculateCost(row.model, row.total_tokens_in || 0, row.total_tokens_out || 0);
      totalCost += cost;
      
      return {
        model: row.model,
        tokens_in: row.total_tokens_in || 0,
        tokens_out: row.total_tokens_out || 0,
        cost: cost.toFixed(4)
      };
    });
    
    res.json({
      period,
      total_cost: totalCost.toFixed(4),
      breakdown
    });
  });
  
  db.close();
});

// API: 獲取當前配置（優化版 - 避免卡住）
app.get('/api/config', async (req, res) => {
  try {
    // 從快取獲取數據
    const openclawData = await getOpenclawData();
    
    // 檢查 Gateway 狀態
    let gatewayRunning = false;
    try {
      const { stdout } = await execAsync('pgrep -f "openclaw-gateway" | head -1', { timeout: 1000 });
      gatewayRunning = stdout.trim() !== '';
    } catch (e) {
      gatewayRunning = false;
    }
    
    // 檢查警告
    const warnings = [];
    if (!gatewayRunning) {
      warnings.push('Gateway 未運行');
    }
    if (openclawData.defaultModel === 'unknown') {
      warnings.push('無法讀取當前模型');
    }
    
    res.json({
      current_model: openclawData.defaultModel,
      gateway_running: gatewayRunning,
      providers: Object.keys(openclawData.models),
      warnings: warnings,
      cache_age: openclawCache.timestamp ? Date.now() - openclawCache.timestamp : null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('獲取配置失敗:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: 切換模型
app.post('/api/switch-model', async (req, res) => {
  try {
    const { model } = req.body;
    
    if (!model) {
      return res.status(400).json({ error: '未提供模型名稱' });
    }
    
    // 讀取當前配置
    if (!fs.existsSync(OPENCLAW_CONFIG_PATH)) {
      return res.status(404).json({ error: 'OpenClaw 配置文件不存在' });
    }
    
    const configContent = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf8');
    const config = JSON.parse(configContent);
    
    // 更新 primary 模型（正確路徑）
    if (!config.agents) config.agents = {};
    if (!config.agents.defaults) config.agents.defaults = {};
    if (!config.agents.defaults.model) config.agents.defaults.model = {};
    
    config.agents.defaults.model.primary = model;
    
    // 寫回配置文件
    fs.writeFileSync(OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8');
    
    // 重啟 Gateway（使用 gateway restart 指令）
    try {
      await execAsync('openclaw gateway restart');
      await new Promise(resolve => setTimeout(resolve, 3000)); // 等待 Gateway 完全重啟
      
      // 清除快取，強制重新讀取配置
      openclawCache.timestamp = 0;
      await updateOpenclawCache();
    } catch (e) {
      console.warn('Gateway 重啟警告:', e.message);
    }
    
    res.json({ 
      success: true, 
      message: `已切換到 ${model}`,
      new_model: model
    });
  } catch (error) {
    console.error('切換模型失敗:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: 配額詳情（從快取讀取）
app.get('/api/quota-status', async (req, res) => {
  try {
    const openclawData = await getOpenclawData();
    
    res.json({
      providers: openclawData.models,
      current_model: openclawData.defaultModel,
      cache_age: openclawCache.timestamp ? Date.now() - openclawCache.timestamp : null,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('獲取配額狀態失敗:', error);
    res.status(500).json({ error: error.message });
  }
});

// API: 模型用量分析
app.get('/api/model-analytics', (req, res) => {
  const db = getDb();
  const { period = 'today' } = req.query;
  
  let timeFilter = '';
  switch (period) {
    case 'today':
      timeFilter = "AND date(timestamp) = date('now')";
      break;
    case 'week':
      timeFilter = "AND timestamp >= datetime('now', '-7 days')";
      break;
    case 'month':
      timeFilter = "AND timestamp >= datetime('now', '-30 days')";
      break;
  }
  
  db.all(`
    SELECT 
      provider || '/' || model as full_model,
      provider,
      model,
      SUM(input_tokens) as total_in,
      SUM(output_tokens) as total_out,
      SUM(input_tokens + output_tokens) as total_tokens,
      COUNT(*) as request_count
    FROM token_usage
    WHERE 1=1 ${timeFilter}
    GROUP BY provider, model
    ORDER BY total_tokens DESC
  `, (err, rows) => {
    if (err) {
      console.error('查詢模型分析失敗:', err);
      res.status(500).json({ error: err.message });
      db.close();
      return;
    }
    
    const totalTokens = rows.reduce((sum, r) => sum + r.total_tokens, 0);
    
    const analytics = rows.map(row => ({
      model: row.full_model,
      provider: row.provider,
      tokens_in: row.total_in,
      tokens_out: row.total_out,
      total_tokens: row.total_tokens,
      percentage: totalTokens > 0 ? ((row.total_tokens / totalTokens) * 100).toFixed(2) : 0,
      requests: row.request_count
    }));
    
    res.json({
      period,
      total_tokens: totalTokens,
      models: analytics
    });
    
    db.close();
  });
});

// 健康檢查
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 手動觸發數據收集（測試用）
app.post('/api/collect-now', async (req, res) => {
  try {
    await collectUsageData();
    res.json({ success: true, message: '數據收集已完成' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 初始化快取
async function initializeCache() {
  console.log('⏳ 初始化 OpenClaw 快取...');
  await updateOpenclawCache();
  
  // 每 30 秒定時更新一次
  setInterval(updateOpenclawCache, openclawCache.ttl);
  console.log(`✅ 已設置快取自動更新（每 ${openclawCache.ttl / 1000} 秒）`);
}

// 初始化數據收集器
async function initializeDataCollector() {
  console.log('⏳ 初始化數據收集器...');
  
  // 立即執行一次
  await collectUsageData();
  
  // 每 5 分鐘收集一次（300000 毫秒）
  setInterval(collectUsageData, 300000);
  console.log('✅ 已設置數據收集器（每 5 分鐘）');
}

// 啟動伺服器
app.listen(PORT, async () => {
  console.log(`🚀 Token Dashboard running at http://localhost:${PORT}`);
  console.log(`📊 API endpoints:`);
  console.log(`   - GET /api/config`);
  console.log(`   - GET /api/models`);
  console.log(`   - GET /api/quota-status`);
  console.log(`   - GET /api/overview?period=today|week|month`);
  console.log(`   - GET /api/rate-limits`);
  console.log(`   - GET /api/history?days=7`);
  console.log(`   - GET /api/cost?period=today|week|month`);
  console.log(`   - GET /api/health`);
  
  // 初始化快取
  await initializeCache();
  
  // 初始化數據收集器
  await initializeDataCollector();
});

module.exports = app;
