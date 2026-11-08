export const DOCUMENT_STYLE = `
.document-surface{width:100%;max-width:1360px;margin:0 auto;color:var(--color-ink)}
.document-top{padding:16px 32px;min-height:76px;gap:12px}
.document-back{display:inline-flex;align-items:center;gap:8px;min-height:44px;color:var(--color-ink-2);font-size:var(--text-meta);font-weight:600}
.document-back:hover{color:var(--color-ink)}
.document-tools{display:flex;align-items:center;gap:6px;margin-left:auto;position:relative}
.document-tools>button,.document-tools>a{display:inline-flex;min-height:44px;min-width:44px;align-items:center;justify-content:center;gap:8px;padding:0 14px;border:1px solid var(--color-line-3);border-radius:14px;background:var(--color-panel);color:var(--color-ink);font-size:var(--text-meta);font-weight:600;cursor:pointer}
.document-body{padding:8px 32px 48px}
.document-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:28px}
.document-heading h1{font-size:var(--text-screen-wide);line-height:1.2;font-weight:700;letter-spacing:-.035em;margin:0}
.document-kicker{display:flex;align-items:center;gap:8px;margin-bottom:12px;font-size:var(--text-small);font-weight:600;color:var(--color-ink-2)}
.document-heading-note{font-size:var(--text-meta);color:var(--color-ink-2);margin-top:8px}
.document-controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:24px}
.document-controls input{background:var(--color-panel)}
.document-controls button,.document-controls label{border-color:var(--color-line-3)}
.document-count{font-size:var(--text-meta);color:var(--color-ink-2);white-space:nowrap}
.document-table{width:100%;border-collapse:separate;border-spacing:0;text-align:left;font-size:var(--text-body)}
.document-table thead th{padding:14px 16px;color:var(--color-ink-2);font-size:var(--text-small);font-weight:500;border-top:1px solid var(--color-line);border-bottom:1px solid var(--color-line)}
.document-table thead th:first-child,.document-table td:first-child{padding-left:0}
.document-table td{padding:20px 16px;border-bottom:1px solid var(--color-line);vertical-align:middle}
.document-table td:first-child{width:42%}
.document-table tbody tr:hover td{background:var(--color-hover)}
.document-table .document-pin-heading{padding:22px 0 6px;font-size:var(--text-small);font-weight:600;color:var(--color-ink-2)}
.document-title-link{display:flex;align-items:center;gap:16px;min-height:48px;font-weight:600;color:var(--color-ink)}
.document-page-icon{display:flex;align-items:center;justify-content:center;width:40px;height:48px;flex:none;border:1px solid var(--color-line-3);border-radius:8px;background:var(--color-panel);color:var(--color-ink-2)}
.document-title-copy{display:grid;gap:5px;min-width:0;overflow-wrap:anywhere}
.document-title-copy small{font-size:var(--text-small);font-weight:400;color:var(--color-ink-2)}
.document-mark{display:inline-flex;align-items:center;gap:6px;font-size:var(--text-small);font-weight:600;white-space:nowrap}
.document-live{color:var(--color-green)}
.document-public{color:var(--color-link)}
.document-phone-list section h2{display:flex;align-items:center;gap:7px;font-size:var(--text-small);font-weight:600;color:var(--color-ink-2);margin:24px 0 8px}
.document-phone-row{display:flex;align-items:flex-start;gap:14px;padding:22px 0;border-bottom:1px solid var(--color-line)}
.document-phone-row .document-title-copy{flex:1;gap:10px}
.document-phone-row b{font-size:var(--text-row);font-weight:600;line-height:1.4}
.document-phone-meta{display:flex;flex-wrap:wrap;gap:4px 7px;font-size:var(--text-meta);line-height:1.5;color:var(--color-ink-2)}
.document-phone-marks{display:flex;gap:14px;margin-top:3px}
.document-reader-heading{padding-bottom:20px;border-bottom:1px solid var(--color-line)}
.document-reader-heading h1{font-size:var(--text-screen-wide);line-height:1.2;font-weight:700;letter-spacing:-.035em;overflow-wrap:anywhere}
.document-reader-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;margin-top:14px;color:var(--color-ink-2);font-size:var(--text-meta)}
.document-reader-facts{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
.document-version{display:flex;align-items:center;gap:20px;padding:10px 14px;margin-top:18px;border:1px solid var(--color-line-3);border-radius:12px;background:var(--color-panel);font-size:var(--text-body)}
.document-version>span{flex:1}
.document-version button{color:var(--color-link)}
.document-public-panel{margin-top:20px;padding:18px 20px;background:var(--color-panel);border:1px solid var(--color-line-3);border-radius:14px;font-size:var(--text-meta)}
.document-public-panel button{border-color:var(--color-line-3)}
.document-public-panel code{padding:4px 0 8px}
.document-confirm{margin-top:20px;padding:22px;background:var(--color-panel);border:1px solid var(--color-brass);border-radius:16px;font-size:var(--text-body);gap:16px}
.document-confirm>p:first-child{font-size:var(--text-row);color:var(--color-ink)}
.document-confirm ul{padding:0;display:grid;gap:8px;list-style:none;color:var(--color-ink-2)}
.document-confirm ul li:last-child{color:var(--color-red);font-weight:600}
.document-confirm button:not(.brass-fill){border-color:var(--color-line-3)}
.document-frame{margin-top:22px;height:calc(100dvh - 285px);min-height:420px;border:1px solid var(--color-line-3);border-radius:12px;overflow:hidden;display:flex;flex-direction:column;background:var(--color-paper)}
.document-frame-label{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px;color:var(--color-ink-2);font-size:var(--text-small)}
.document-frame-label+.document-frame{margin-top:10px}
.document-empty{margin:40px auto;max-width:560px;padding:32px;border:1px solid var(--color-line-3);border-radius:16px;background:var(--color-panel)}
.document-empty h1{font-size:var(--text-title-lg);font-weight:700;line-height:1.3;margin:18px 0 10px}
.document-empty p{color:var(--color-ink-2);font-size:var(--text-body)}
.document-artifacts{display:grid;grid-template-columns:minmax(240px,340px) minmax(0,1fr);border-top:1px solid var(--color-line);margin-top:24px}
.document-artifact-list{padding:20px 24px 24px 0;border-right:1px solid var(--color-line);min-width:0}
.document-artifact-list h2{font-size:var(--text-row);font-weight:600;margin-bottom:16px}
.document-artifact-controls{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;margin-bottom:16px}
.document-artifact-controls select{border:1px solid var(--color-line-3);border-radius:12px;padding:0 8px;background:var(--color-panel);color:var(--color-ink);min-height:44px;font-size:var(--text-small);max-width:90px}
.document-artifact-row{display:grid;gap:5px;padding:16px 12px;min-height:80px;border-radius:12px;font-size:var(--text-meta);overflow-wrap:anywhere}
.document-artifact-row[aria-current=page]{background:var(--color-brass-soft);box-shadow:inset 3px 0 var(--color-brass)}
.document-artifact-row b{font-size:var(--text-note);font-weight:600}
.document-artifact-row small{font-size:var(--text-small);color:var(--color-ink-2)}
.document-artifact-reader{padding:24px 0 0 28px;min-width:0}
.document-artifact-reader h2{font-size:var(--text-title);font-weight:700;letter-spacing:-.02em;overflow-wrap:anywhere}
.document-artifact-reader dl{margin:14px 0;font-size:var(--text-meta)}
.document-artifact-reader .document-file{margin-top:20px;border:1px solid var(--color-line-3);border-radius:12px;overflow:hidden;background:var(--color-well)}
.document-file>div{display:flex;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--color-line);font-size:var(--text-small);color:var(--color-ink-2)}
.document-file pre{margin:0;padding:18px;font:var(--text-code)/1.7 var(--font-mono);white-space:pre-wrap;overflow-wrap:anywhere;color:var(--color-code-ink);max-height:520px;overflow:auto}
@media(max-width:699px){
.document-surface{padding-top:80px;scroll-padding-top:84px}
.document-surface :is(input,button,a,pre){scroll-margin-top:88px}
.document-tool{display:inline-flex;height:44px;min-width:44px;align-items:center;justify-content:center;gap:8px;padding:0 12px;border-radius:999px;color:var(--color-ink);font-size:var(--text-meta);font-weight:600;cursor:pointer}
.document-page-more{font-size:var(--text-title)}
.document-body{padding:8px 20px 36px}
.document-heading{margin-bottom:24px;gap:12px;align-items:center}
.document-heading h1{font-size:var(--text-screen)}
.document-kicker{margin-bottom:10px}
.document-heading-note{font-size:var(--text-meta)}
.document-controls{gap:8px;margin-bottom:14px}
.document-controls>div:first-child{flex-basis:100%}
.document-reader-heading h1{font-size:var(--text-screen)}
.document-reader-meta{gap:10px;margin-top:12px}
.document-reader-heading{padding-bottom:18px}
.document-frame{height:calc(100dvh - 310px);min-height:420px;border-radius:8px}
.document-frame-label{margin-top:18px}
.document-version{gap:10px;padding:8px 12px;font-size:var(--text-note)}
.document-public-panel{padding:16px;gap:10px}
.document-confirm{padding:18px;gap:12px}
.document-confirm ul{font-size:var(--text-note);gap:6px}
.document-empty{margin-top:24px;padding:24px}
.document-artifacts{grid-template-columns:minmax(0,1fr);margin-top:20px}
.document-artifact-list{border:0;padding:18px 0 20px}
.document-artifact-list h2{display:none}
.document-artifact-controls{margin-bottom:10px}
.document-artifact-row{padding:12px;min-height:68px;gap:3px}
.document-artifact-reader{padding:22px 0 0;border-top:1px solid var(--color-line)}
.document-artifact-reader h2{font-size:var(--text-title)}
.document-artifact-reader dl{margin:10px 0}
.document-file pre{padding:14px;font-size:var(--text-small)}
}
`;
