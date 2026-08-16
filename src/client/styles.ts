/**
 * 面板样式：一段 CSS 在工厂执行时注入 <style>。
 * 全部走 DSH 设计 token 并带回退值，宿主换肤 / 暗色下自动跟随；
 * token 不存在时回退到可读的浅色方案，面板独立可用。
 */

const STYLE_ID = 'dsh-memory-porter-style'

export const css = `
.mp-chip{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:8px;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;cursor:pointer;user-select:none;white-space:nowrap}
.mp-chip:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f4f7);border-color:var(--dsw-alias-state-business-primary,#3370ff)}
.mp-chip-dot{width:6px;height:6px;border-radius:999px;background:#e8882a}

/* 侧边栏底部入口：跟「设置」那一排对齐，收起时只剩图标。 */
.mp-side{display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-secondary,#51565d);font-size:13px;cursor:pointer;text-align:left}
.mp-side:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f4f7);color:var(--dsw-alias-label-primary,#1f2329)}
.mp-side-icon{font-size:15px;line-height:1;flex:none}
.mp-side-label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mp-side-count{font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#8f959e)}

.mp-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:flex-start;justify-content:center;padding:6vh 16px 16px;background:rgba(15,18,25,.45);backdrop-filter:blur(2px)}
.mp-panel{width:min(820px,100%);max-height:88vh;display:flex;flex-direction:column;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#1f2329);box-shadow:0 18px 60px rgba(0,0,0,.22);font-size:13px}
.mp-head{display:flex;align-items:center;gap:10px;padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,#e3e6eb)}
.mp-head-icon{font-size:22px;line-height:1}
.mp-head-title{font-size:16px;font-weight:700}
.mp-head-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8f959e)}
.mp-close{margin-left:auto;border:0;background:none;color:var(--dsw-alias-label-tertiary,#8f959e);font-size:18px;cursor:pointer;padding:2px 6px;border-radius:6px}
.mp-close:hover{background:var(--dsw-alias-interactive-bg-hover,#f2f4f7)}

.mp-tabs{display:flex;gap:4px;padding:10px 20px 0}
.mp-tab{border:0;background:none;padding:6px 12px;border-radius:8px 8px 0 0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,#51565d);cursor:pointer}
.mp-tab[data-on="1"]{background:var(--dsw-alias-interactive-bg-hover,#f2f4f7);color:var(--dsw-alias-label-primary,#1f2329)}
.mp-tab-count{margin-left:5px;font-size:11px;font-weight:700;color:var(--dsw-alias-state-business-primary,#3370ff);font-variant-numeric:tabular-nums}

.mp-body{padding:16px 20px 20px;overflow:auto}
.mp-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.mp-card{border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:12px;padding:10px 12px}
.mp-card.hero{background:linear-gradient(135deg,rgba(51,112,255,.08),rgba(51,112,255,.02))}
.mp-card-label{font-size:11px;color:var(--dsw-alias-label-tertiary,#8f959e)}
.mp-card-value{margin-top:2px;font-size:22px;font-weight:700;font-variant-numeric:tabular-nums}
.mp-card-hint{margin-top:2px;font-size:11px;color:var(--dsw-alias-label-secondary,#51565d)}

.mp-btn{border:1px solid var(--dsw-alias-state-business-primary,#3370ff);background:var(--dsw-alias-state-business-primary,#3370ff);color:#fff;border-radius:8px;padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer}
.mp-btn:disabled{opacity:.5;cursor:default}
.mp-btn.ghost{background:none;color:var(--dsw-alias-state-business-primary,#3370ff)}
.mp-btn.plain{border-color:var(--dsw-alias-border-l1,#e3e6eb);background:none;color:var(--dsw-alias-label-secondary,#51565d)}
.mp-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:14px}

.mp-note{margin-top:12px;padding:10px 12px;border-radius:10px;font-size:12px;line-height:1.6;background:var(--dsw-alias-interactive-bg-hover,#f2f4f7);color:var(--dsw-alias-label-secondary,#51565d)}
.mp-note b{color:var(--dsw-alias-label-primary,#1f2329)}
.mp-alert{margin-top:12px;padding:9px 12px;border-radius:10px;font-size:12px;font-weight:600;background:rgba(232,138,42,.10);border:1px solid rgba(232,138,42,.28);color:#b06a12}

/* 档位选择：三档并排，说明写在选项里而不是藏进 tooltip。 */
.mp-modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin-top:10px}
.mp-mode{text-align:left;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:10px;padding:9px 11px;background:none;color:inherit;cursor:pointer}
.mp-mode[data-on="1"]{border-color:var(--dsw-alias-state-business-primary,#3370ff);background:rgba(51,112,255,.06)}
.mp-mode-name{font-size:12px;font-weight:700}
.mp-mode-desc{margin-top:3px;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#51565d)}

/* 入库依据：每条记忆都挂一个，颜色区分"自动"与"要你看"。 */
.mp-reason{display:inline-block;padding:2px 7px;border-radius:999px;font-size:10px;font-weight:700;white-space:nowrap}
.mp-reason.auto{background:rgba(52,163,101,.12);color:#2d8a56}
.mp-reason.human{background:rgba(232,138,42,.14);color:#b06a12}
.mp-reasons{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}

.mp-item{border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:12px;padding:12px 14px;margin-top:10px}
.mp-item-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mp-type{padding:2px 7px;border-radius:6px;font-size:10px;font-weight:700;background:var(--dsw-alias-interactive-bg-hover,#f2f4f7);color:var(--dsw-alias-label-secondary,#51565d)}
.mp-claim{margin-top:7px;font-size:14px;font-weight:600;line-height:1.5}
.mp-evidence{margin-top:7px;padding:8px 10px;border-left:3px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:0 8px 8px 0;background:var(--dsw-alias-interactive-bg-hover,#f2f4f7);font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word;max-height:180px;overflow:auto}
.mp-meta{margin-top:7px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8f959e);font-variant-numeric:tabular-nums}
.mp-item-actions{display:flex;gap:8px;margin-top:10px}

/* 两条并列的入口：免费那条在上，花钱那条在下，各自框起来不互相干扰。 */
.mp-lane{margin-top:14px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:12px}
.mp-lane-head{display:flex;align-items:center;gap:8px;font-size:13px;flex-wrap:wrap}
.mp-lane-tag{padding:2px 8px;border-radius:999px;font-size:10px;font-weight:700;background:var(--dsw-alias-interactive-bg-hover,#f2f4f7);color:var(--dsw-alias-label-secondary,#51565d)}
.mp-lane-tag.free{background:rgba(52,163,101,.14);color:#2d8a56}
.mp-lane code{padding:1px 5px;border-radius:4px;font-size:11px;background:var(--dsw-alias-interactive-bg-hover,#f2f4f7)}
.mp-linkish{margin-top:10px;border:0;background:none;padding:0;font-size:12px;color:var(--dsw-alias-state-business-primary,#3370ff);cursor:pointer;text-decoration:underline}
.mp-linkish:disabled{opacity:.5;cursor:default}

.mp-field{display:flex;align-items:center;gap:8px;flex:1;min-width:220px}
.mp-field-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#51565d);white-space:nowrap}

.mp-search{display:flex;gap:8px;margin-bottom:4px}
.mp-input{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l1,#e3e6eb);border-radius:8px;padding:7px 11px;font-size:13px;background:var(--dsw-alias-bg-base,#fff);color:inherit}
.mp-empty{padding:34px 10px;text-align:center;font-size:13px;color:var(--dsw-alias-label-tertiary,#8f959e);line-height:1.8}
`

/** 幂等注入：重复挂载不会堆出多份 <style>。 */
export function injectStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = css
  document.head.appendChild(style)
}
