// Token Dashboard - Frontend JavaScript

const API_BASE = '/api';
let currentPage = 'overview';
let currentFilter = 'all'; // 保存總覽頁面的 filter 狀態
let countdownValue = 1.0;
let countdownInterval;

// 初始化
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  loadPage('overview');
  updateControlPanel();
  startCountdown();
  
  // 控制面板每 1 秒更新
  setInterval(() => {
    updateControlPanel();
  }, 1000);
  
  // 其他頁面每 1 秒刷新
  setInterval(() => {
    if (currentPage && currentPage !== 'quota') {
      loadPage(currentPage, false);
    }
  }, 1000);
  
  // 配額詳情每 5 分鐘刷新
  setInterval(() => {
    if (currentPage === 'quota') {
      loadPage(currentPage, false);
    }
  }, 300000); // 5 分鐘 = 300000ms
});

// 導航設置
function setupNavigation() {
  const navBtns = document.querySelectorAll('.nav-btn');
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      navBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadPage(page);
    });
  });
}

// 載入頁面
async function loadPage(page, showLoading = true) {
  currentPage = page;
  const content = document.getElementById('content');
  
  if (showLoading) {
    content.innerHTML = '<div class="loading">載入中...</div>';
  }
  
  try {
    switch (page) {
      case 'overview':
        await renderOverview(currentFilter);
        break;
      case 'quota':
        await renderQuota();
        break;
      case 'models':
        await renderModels();
        break;
      case 'model-analytics':
        await renderModelAnalytics();
        break;
      case 'rate-limits':
        await renderRateLimits();
        break;
      case 'history':
        await renderHistory();
        break;
      case 'cost':
        await renderCost();
        break;
    }
  } catch (error) {
    content.innerHTML = `<div class="error">載入失敗：${error.message}</div>`;
  }
}

// 渲染總覽頁
async function renderOverview(filter = 'all') {
  // 保存 filter 狀態
  currentFilter = filter;
  
  // 並行獲取：即時統計 + DB 統計
  const [live, today, week, month] = await Promise.all([
    fetch(`${API_BASE}/live-stats?filter=${filter}`).then(r => r.json()),
    fetch(`${API_BASE}/overview?period=today`).then(r => r.json()),
    fetch(`${API_BASE}/overview?period=week`).then(r => r.json()),
    fetch(`${API_BASE}/overview?period=month`).then(r => r.json())
  ]);
  
  const content = document.getElementById('content');
  
  // 使用即時統計（live）代替 DB 統計，更快更準確
  const todayTokens = live.total_tokens || today.total_tokens;
  const estimatedCost = (todayTokens / 1000000 * 3).toFixed(2); // 粗估
  
  // 過濾選項
  const filterBtns = `
    <div style="margin-bottom: 20px; display: flex; gap: 10px;">
      <button class="btn-select ${filter === 'all' ? 'active' : ''}" onclick="renderOverview('all')" style="padding: 8px 16px; ${filter === 'all' ? 'background: #00ff88; color: #000;' : ''}">全部</button>
      <button class="btn-select ${filter === 'dm' ? 'active' : ''}" onclick="renderOverview('dm')" style="padding: 8px 16px; ${filter === 'dm' ? 'background: #00ff88; color: #000;' : ''}">僅私聊</button>
      <button class="btn-select ${filter === 'group' ? 'active' : ''}" onclick="renderOverview('group')" style="padding: 8px 16px; ${filter === 'group' ? 'background: #00ff88; color: #000;' : ''}">僅群組</button>
      <span style="margin-left: auto; color: #888; align-self: center;">📊 ${live.period || '過去 24 小時'}</span>
    </div>
  `;
  
  content.innerHTML = filterBtns + `
    <div class="stats-grid">
      <div class="stat-card">
        <h3>${filter === 'all' ? '總消耗' : filter === 'dm' ? '私聊消耗' : '群組消耗'} <span style="color: #00ff88; font-size: 0.7rem;">●即時</span></h3>
        <div class="value">${formatNumber(todayTokens)}</div>
        <div class="label">tokens (~$${estimatedCost})</div>
      </div>
      <div class="stat-card">
        <h3>本週消耗</h3>
        <div class="value">${formatNumber(week.total_tokens)}</div>
        <div class="label">tokens ($${week.estimated_cost.toFixed(2)})</div>
      </div>
      <div class="stat-card">
        <h3>本月消耗</h3>
        <div class="value">${formatNumber(month.total_tokens)}</div>
        <div class="label">tokens ($${month.estimated_cost.toFixed(2)})</div>
      </div>
      <div class="stat-card">
        <h3>活躍 Sessions</h3>
        <div class="value">${live.sessions_count || 0}</div>
        <div class="label">個</div>
      </div>
    </div>
    
    <div class="section">
      <h2><i data-lucide="trending-up" style="width: 24px; height: 24px; stroke: currentColor; vertical-align: middle; margin-right: 8px;"></i>Token 消耗分佈</h2>
      <div class="chart-container">
        <div style="margin-bottom: 15px;">
          <strong>Input:</strong> ${formatNumber(today.total_tokens_in)} tokens
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${(today.total_tokens_in / today.total_tokens * 100) || 0}%">
              ${((today.total_tokens_in / today.total_tokens * 100) || 0).toFixed(1)}%
            </div>
          </div>
        </div>
        <div>
          <strong>Output:</strong> ${formatNumber(today.total_tokens_out)} tokens
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${(today.total_tokens_out / today.total_tokens * 100) || 0}%">
              ${((today.total_tokens_out / today.total_tokens * 100) || 0).toFixed(1)}%
            </div>
          </div>
        </div>
      </div>
    </div>
    
    <div class="section">
      <h2><i data-lucide="message-circle" style="width: 24px; height: 24px; stroke: currentColor; vertical-align: middle; margin-right: 8px;"></i>Session 類型分佈</h2>
      <div class="chart-container" style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px;">
        ${['dm', 'group', 'cron', 'other'].map(type => {
          const tokens = live.by_type?.[type] || 0;
          const percentage = todayTokens > 0 ? ((tokens / todayTokens) * 100).toFixed(1) : 0;
          let label, icon, desc;
          switch(type) {
            case 'dm':
              label = '私聊';
              icon = '💬';
              desc = '你與我的對話';
              break;
            case 'group':
              label = '群組';
              icon = '👥';
              desc = '群組討論';
              break;
            case 'cron':
              label = 'Cron';
              icon = '⏰';
              desc = '自動排程任務';
              break;
            default:
              label = '其他';
              icon = '📝';
              desc = 'Main/Isolated sessions';
          }
          return `
            <div class="stat-card" style="text-align: center;">
              <div style="font-size: 2rem; margin-bottom: 10px;" title="${desc}">${icon}</div>
              <strong>${label}</strong>
              <div style="font-size: 0.8rem; color: #888; margin-bottom: 10px;">${desc}</div>
              <div style="font-size: 1.2rem; margin: 10px 0;">${formatNumber(tokens)}</div>
              <div style="color: #888; font-size: 0.9rem;">${percentage}%</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
    
    <div class="section">
      <h2><i data-lucide="cpu" style="width: 24px; height: 24px; stroke: currentColor; vertical-align: middle; margin-right: 8px;"></i>模型使用分佈 <span style="color: #00ff88; font-size: 0.8rem;">●即時</span></h2>
      <div class="chart-container">
        ${Object.keys(live.models || {}).length > 0 
          ? Object.entries(live.models).map(([model, tokens]) => {
              const percentage = ((tokens / todayTokens) * 100).toFixed(1);
              return `
                <div style="margin-bottom: 10px;">
                  <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                    <span class="status-badge status-ok">${model}</span>
                    <span>${formatNumber(tokens)} tokens (${percentage}%)</span>
                  </div>
                  <div class="progress-bar">
                    <div class="progress-fill" style="width: ${percentage}%;"></div>
                  </div>
                </div>
              `;
            }).join('')
          : '<span style="color: #888;">暫無數據</span>'
        }
      </div>
    </div>
  `;
  lucide.createIcons(); // 初始化新加入的 icons
}

// 渲染模型頁
async function renderModels() {
  const data = await fetch(`${API_BASE}/models`).then(r => r.json());
  
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="section">
      <h2><i data-lucide="bar-chart-3" style="width: 24px; height: 24px; stroke: currentColor; vertical-align: middle; margin-right: 8px;"></i>模型配額狀態</h2>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>模型</th>
            <th>剩餘配額</th>
            <th>重置時間</th>
            <th>狀態</th>
          </tr>
        </thead>
        <tbody>
          ${data.models.map(m => `
            <tr>
              <td>${m.provider}</td>
              <td>${m.model}</td>
              <td>
                <div class="progress-bar">
                  <div class="progress-fill" style="width: ${m.quota_left}%; background: ${getQuotaColor(m.quota_left)}">
                    ${m.quota_left}%
                  </div>
                </div>
              </td>
              <td>${m.reset_time || 'N/A'}</td>
              <td><span class="status-badge ${getQuotaStatus(m.quota_left)}">${getQuotaLabel(m.quota_left)}</span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// 渲染速率限制頁
async function renderRateLimits() {
  const data = await fetch(`${API_BASE}/rate-limits`).then(r => r.json());
  
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="section">
      <h2><i data-lucide="zap" style="width: 24px; height: 24px; stroke: currentColor; vertical-align: middle; margin-right: 8px;"></i>速率限制監控</h2>
      <table>
        <thead>
          <tr>
            <th>Provider</th>
            <th>RPM</th>
            <th>TPM</th>
            <th>Cooldown</th>
            <th>更新時間</th>
          </tr>
        </thead>
        <tbody>
          ${data.rate_limits.map(rl => `
            <tr>
              <td>${rl.provider}</td>
              <td>${rl.rpm}</td>
              <td>${rl.tpm}</td>
              <td>${rl.cooldown_until || 'N/A'}</td>
              <td>${formatTime(rl.timestamp)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    
    <div class="section">
      <h2><i data-lucide="info" style="width: 24px; height: 24px; stroke: currentColor; vertical-align: middle; margin-right: 8px;"></i>說明</h2>
      <div class="chart-container">
        <p><strong>RPM (Requests Per Minute)</strong>: 每分鐘請求數限制</p>
        <p><strong>TPM (Tokens Per Minute)</strong>: 每分鐘 Token 數限制</p>
        <p><strong>Cooldown</strong>: 速率限制觸發後的冷卻時間</p>
      </div>
    </div>
  `;
  lucide.createIcons(); // 初始化新加入的 icons
}

// 渲染歷史頁
async function renderHistory() {
  const data = await fetch(`${API_BASE}/history?days=7`).then(r => r.json());
  
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="section">
      <h2><i data-lucide="calendar" style="width: 24px; height: 24px; stroke: currentColor; vertical-align: middle; margin-right: 8px;"></i>最近 7 天用量</h2>
      <table>
        <thead>
          <tr>
            <th>日期</th>
            <th>Total Tokens</th>
            <th>Input</th>
            <th>Output</th>
            <th>請求數</th>
          </tr>
        </thead>
        <tbody>
          ${data.history.map(h => `
            <tr>
              <td>${h.date}</td>
              <td><strong>${formatNumber(h.total_tokens)}</strong></td>
              <td>${formatNumber(h.tokens_in)}</td>
              <td>${formatNumber(h.tokens_out)}</td>
              <td>${h.requests}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  lucide.createIcons(); // 初始化新加入的 icons
}

// 渲染成本頁
async function renderCost() {
  const [today, week, month] = await Promise.all([
    fetch(`${API_BASE}/cost?period=today`).then(r => r.json()),
    fetch(`${API_BASE}/cost?period=week`).then(r => r.json()),
    fetch(`${API_BASE}/cost?period=month`).then(r => r.json())
  ]);
  
  const content = document.getElementById('content');
  content.innerHTML = `
    <div class="stats-grid">
      <div class="stat-card">
        <h3>今日成本</h3>
        <div class="value">$${today.total_cost}</div>
      </div>
      <div class="stat-card">
        <h3>本週成本</h3>
        <div class="value">$${week.total_cost}</div>
      </div>
      <div class="stat-card">
        <h3>本月成本</h3>
        <div class="value">$${month.total_cost}</div>
      </div>
      <div class="stat-card">
        <h3>預估月底</h3>
        <div class="value">$${(parseFloat(month.total_cost) * 30 / new Date().getDate()).toFixed(2)}</div>
      </div>
    </div>
    
    <div class="section">
      <h2><i data-lucide="dollar-sign" style="width: 24px; height: 24px; stroke: currentColor; vertical-align: middle; margin-right: 8px;"></i>成本分解（本月）</h2>
      <table>
        <thead>
          <tr>
            <th>模型</th>
            <th>Input Tokens</th>
            <th>Output Tokens</th>
            <th>成本</th>
          </tr>
        </thead>
        <tbody>
          ${month.breakdown.map(b => `
            <tr>
              <td>${b.model}</td>
              <td>${formatNumber(b.tokens_in)}</td>
              <td>${formatNumber(b.tokens_out)}</td>
              <td><strong>$${b.cost}</strong></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// 工具函數
function formatNumber(num) {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(2) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(2) + 'k';
  }
  return num.toString();
}

function formatTime(timestamp) {
  if (!timestamp) return 'N/A';
  const date = new Date(timestamp);
  return date.toLocaleString('zh-TW');
}

function getQuotaColor(percent) {
  if (percent >= 70) return 'linear-gradient(90deg, #28a745 0%, #20c997 100%)';
  if (percent >= 30) return 'linear-gradient(90deg, #ffc107 0%, #fd7e14 100%)';
  return 'linear-gradient(90deg, #dc3545 0%, #c82333 100%)';
}

function getQuotaStatus(percent) {
  if (percent >= 70) return 'status-ok';
  if (percent >= 30) return 'status-warning';
  return 'status-error';
}

function getQuotaLabel(percent) {
  if (percent >= 70) return '正常';
  if (percent >= 30) return '注意';
  return '警告';
}

// ==================== 控制面板功能 ====================

// 更新頂部控制面板
async function updateControlPanel() {
  try {
    const config = await fetch(`${API_BASE}/config`).then(r => r.json());
    
    // 更新當前模型
    const currentModelEl = document.getElementById('current-model');
    if (currentModelEl) {
      currentModelEl.textContent = config.current_model || '未知';
    }
    
    // 更新 Gateway 狀態
    const statusDot = document.getElementById('gateway-status');
    if (statusDot) {
      statusDot.className = 'status-dot pulsing ' + (config.gateway_running ? 'status-ok' : 'status-error');
    }
    
    // 更新配額
    const quotaPercent = config.quota_remaining || 0;
    const quotaPercentEl = document.getElementById('quota-percent');
    const quotaProgress = document.getElementById('quota-progress');
    
    if (quotaPercentEl) {
      quotaPercentEl.textContent = quotaPercent + '%';
    }
    
    if (quotaProgress) {
      const strokeColor = quotaPercent >= 70 ? '#28a745' : quotaPercent >= 30 ? '#ffc107' : '#dc3545';
      quotaProgress.setAttribute('stroke', strokeColor);
      quotaProgress.setAttribute('stroke-dasharray', `${quotaPercent}, 100`);
    }
    
    // 檢查是否有警告
    if (config.warnings && config.warnings.length > 0) {
      showAlertBanner(config.warnings[0]);
    } else {
      hideAlertBanner();
    }
  } catch (error) {
    console.error('更新控制面板失敗:', error);
  }
}

// 倒數計時器
function startCountdown() {
  const timerEl = document.getElementById('countdown-timer');
  
  countdownInterval = setInterval(() => {
    countdownValue -= 0.1;
    if (countdownValue <= 0) {
      countdownValue = 1.0;
    }
    if (timerEl) {
      timerEl.textContent = countdownValue.toFixed(1) + 's';
    }
  }, 100);
}

// 顯示警告橫幅
function showAlertBanner(message) {
  const banner = document.getElementById('alert-banner');
  const messageEl = document.getElementById('alert-message');
  
  if (banner && messageEl) {
    messageEl.textContent = message;
    banner.style.display = 'flex';
  }
}

// 隱藏警告橫幅
function hideAlertBanner() {
  const banner = document.getElementById('alert-banner');
  if (banner) {
    banner.style.display = 'none';
  }
}

// ==================== Toast 通知系統 ====================

function showToast(type, title, message, duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  const icons = {
    success: '<i data-lucide="check-circle"></i>',
    warning: '<i data-lucide="alert-triangle"></i>',
    error: '<i data-lucide="x-circle"></i>',
    info: '<i data-lucide="info"></i>'
  };
  
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <div class="toast-content">
      <strong>${title}</strong>
      <p>${message}</p>
    </div>
    <button class="toast-close" onclick="this.parentElement.remove()"><i data-lucide="x"></i></button>
  `;
  
  container.appendChild(toast);
  lucide.createIcons(); // 初始化新加入的 icons
  
  // 自動移除
  setTimeout(() => {
    toast.style.animation = 'slideInRight 0.3s reverse';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

// ==================== 模型切換 Modal ====================

async function openModelSwitcher() {
  const modal = document.getElementById('modelSwitcherModal');
  const modalBody = document.getElementById('modal-body');
  
  if (!modal || !modalBody) return;
  
  modal.classList.add('active');
  modalBody.innerHTML = '<div class="loading">載入模型列表...</div>';
  
  try {
    const [config, modelsData] = await Promise.all([
      fetch(`${API_BASE}/config`).then(r => r.json()),
      fetch(`${API_BASE}/models`).then(r => r.json())
    ]);
    
    const currentModel = config.current_model;
    
    // 使用後端返回的實際可切換模型列表
    const allModels = modelsData.models || [];
    
    if (allModels.length === 0) {
      modalBody.innerHTML = '<div class="error">無可用模型</div>';
      return;
    }
    
    // 生成模型卡片
    let html = '<div class="model-grid">';
    
    for (const model of allModels) {
      const isCurrent = model.is_current || model.full_name === currentModel;
      const isConfigured = model.is_configured;
      
      const cardClass = isCurrent ? 'model-card current' : 'model-card available';
      
      html += `
        <div class="${cardClass}">
          <div class="model-header">
            ${isCurrent ? '<i data-lucide="star" style="width: 20px; height: 20px; stroke: #ff0080; fill: #ff0080;"></i>' : ''}
            <strong>${model.full_name}</strong>
            ${isCurrent ? '<span class="status-badge status-ok" style="margin-left: auto; font-size: 0.7rem;">當前</span>' : ''}
          </div>
          
          <div class="model-stats">
            <div class="model-stat">
              <span>類型</span>
              <strong style="color: ${isConfigured ? '#00ff88' : '#888'};">${isConfigured ? 'Configured' : 'Fallback'}</strong>
            </div>
            <div class="model-stat">
              <span>Provider</span>
              <strong style="font-size: 0.8rem;">${model.provider}</strong>
            </div>
          </div>
          
          <button class="btn-select" 
                  onclick="switchModel('${model.full_name}')"
                  ${isCurrent ? 'disabled' : ''}>
            ${isCurrent ? '當前使用中' : '切換到此模型'}
          </button>
        </div>
      `;
    }
    
    html += '</div>';
    
    // 智能推薦（推薦 configured 且非當前的模型）
    const recommended = allModels.find(m => m.is_configured && !m.is_current);
    if (recommended) {
      html += `
        <div class="recommendation">
          <i data-lucide="lightbulb" class="recommendation-icon"></i>
          <div style="flex: 1;">
            <strong>智能推薦</strong>
            <p>${recommended.full_name} 已配置可用，建議優先使用</p>
          </div>
          <button class="btn-primary-sm" onclick="switchModel('${recommended.full_name}')">立即切換</button>
        </div>
      `;
    }
    
    modalBody.innerHTML = html;
    lucide.createIcons(); // 初始化新加入的 icons
  } catch (error) {
    modalBody.innerHTML = `<div class="error">載入失敗：${error.message}</div>`;
  }
}

function closeModelSwitcher() {
  const modal = document.getElementById('modelSwitcherModal');
  if (modal) {
    modal.classList.remove('active');
  }
}

// 切換模型
async function switchModel(modelName) {
  const btn = event.target;
  btn.classList.add('loading');
  btn.textContent = '切換中...';
  btn.disabled = true;
  
  try {
    const response = await fetch(`${API_BASE}/switch-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName })
    });
    
    const result = await response.json();
    
    if (response.ok) {
      showToast('success', '切換成功', `已切換到 ${modelName}`);
      closeModelSwitcher();
      updateControlPanel();
    } else {
      throw new Error(result.error || '切換失敗');
    }
  } catch (error) {
    showToast('error', '切換失敗', error.message);
    btn.classList.remove('loading');
    btn.textContent = '切換到此模型';
    btn.disabled = false;
  }
}

// 格式化 Cooldown 時間
function formatCooldown(seconds) {
  if (seconds <= 0) return '0s';
  
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${secs}s`;
  return `${secs}s`;
}

// 渲染配額詳情頁
async function renderQuota() {
  const data = await fetch(`${API_BASE}/quota-status`).then(r => r.json());
  const content = document.getElementById('content');
  
  let html = '<div class="quota-details">';
  
  if (!data.providers || Object.keys(data.providers).length === 0) {
    content.innerHTML = '<div class="error">無法獲取配額信息</div>';
    return;
  }
  
  // 建議優先順序
  const recommendations = {
    'google': { priority: 1, status: '✅ 最穩定' },
    'google-antigravity': { priority: 2, status: '⚠️ 監控中' },
    'openai-codex': { priority: 3, status: '❌ 需切換' }
  };
  
  Object.entries(data.providers).forEach(([provider, models]) => {
    const rec = recommendations[provider] || { priority: 99, status: '❓' };
    const statusColor = rec.priority === 1 ? '#00ff88' : rec.priority === 2 ? '#ffd700' : '#ff4444';
    
    html += `
      <div class="quota-provider" style="border-color: ${statusColor}">
        <h3>${provider} <span style="color: ${statusColor}">${rec.status}</span></h3>
        <table class="quota-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>配額剩餘</th>
              <th>狀態</th>
            </tr>
          </thead>
          <tbody>
    `;
    
    models.forEach(m => {
      // 只顯示有配額信息的模型，跳過 OAuth/static 帳戶
      if (m.authType && m.quota === undefined) return;
      
      const statusEmoji = m.status === 'ok' ? '✅' : '⏳';
      const modelName = m.full_name || m.profile || m.model || 'unknown';
      
      // Static profiles（API key）或無配額數據的顯示 N/A
      let quota;
      if (m.quota !== undefined) {
        quota = `${m.quota}%`;
      } else {
        quota = '<span style="color: #888">N/A</span>';
      }
      
      const statusText = m.status === 'ok' ? '可用' : m.status === 'expired' ? '已過期' : 'Cooldown';
      
      html += `
        <tr>
          <td><code>${modelName}</code></td>
          <td><strong>${quota}</strong></td>
          <td>${statusEmoji} ${statusText}</td>
        </tr>
      `;
    });
    
    html += `
          </tbody>
        </table>
      </div>
    `;
  });
  
  html += '</div>';
  content.innerHTML = html;
}

async function renderModelAnalytics() {
  const content = document.getElementById('content');
  content.innerHTML = '<div class="loading">載入模型分析...</div>';
  
  try {
    const period = 'today'; // 可以後續改為可選
    const data = await fetch(`${API_BASE}/model-analytics?period=${period}`).then(r => r.json());
    
    if (!data.models || data.models.length === 0) {
      content.innerHTML = '<div class="error">暫無數據</div>';
      return;
    }
    
    let html = '<div class="model-analytics">';
    
    // 統計卡片（使用現有的 stats-grid）
    html += `
      <div class="stats-grid">
        <div class="stat-card">
          <h3>總 Token 用量</h3>
          <div class="value">${formatNumber(data.total_tokens)}</div>
          <div class="label">tokens</div>
        </div>
        <div class="stat-card">
          <h3>模型數量</h3>
          <div class="value">${data.models.length}</div>
          <div class="label">個</div>
        </div>
        <div class="stat-card">
          <h3>最常用模型</h3>
          <div class="value" style="font-size: 1rem;">${data.models[0]?.model.split('/')[1] || 'N/A'}</div>
          <div class="label">${((data.models[0]?.percentage) || 0)}%</div>
        </div>
        <div class="stat-card">
          <h3>總請求數</h3>
          <div class="value">${data.models.reduce((sum, m) => sum + (m.requests || 0), 0)}</div>
          <div class="label">次</div>
        </div>
      </div>
    `;
    
    // 模型用量表格
    html += `
      <div class="model-usage-table">
        <h3>模型用量詳情</h3>
        <table class="usage-table">
          <thead>
            <tr>
              <th>模型</th>
              <th>Provider</th>
              <th>Input Tokens</th>
              <th>Output Tokens</th>
              <th>總計</th>
              <th>占比</th>
            </tr>
          </thead>
          <tbody>
    `;
    
    data.models.forEach(m => {
      html += `
        <tr>
          <td><code>${m.model}</code></td>
          <td>${m.provider}</td>
          <td>${formatNumber(m.tokens_in)}</td>
          <td>${formatNumber(m.tokens_out)}</td>
          <td><strong>${formatNumber(m.total_tokens)}</strong></td>
          <td>
            <div class="progress-bar">
              <div class="progress-fill" style="width: ${m.percentage}%; background: linear-gradient(90deg, #00ff88, #00d4ff);"></div>
            </div>
            <span style="margin-left: 10px;">${m.percentage}%</span>
          </td>
        </tr>
      `;
    });
    
    html += `
          </tbody>
        </table>
      </div>
    `;
    
    html += '</div>';
    content.innerHTML = html;
    
    lucide.createIcons();
  } catch (error) {
    console.error('載入模型分析失敗:', error);
    content.innerHTML = '<div class="error">載入失敗</div>';
  }
}

function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
