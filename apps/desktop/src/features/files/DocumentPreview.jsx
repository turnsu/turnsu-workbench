import React from 'react';
export function DocumentPreview({ value }) {
  return <div className="documentPreview"><h4>内容与解析覆盖</h4>{value.warnings?.map((warning, i) => <p key={i} className="capabilityNote">{warning}</p>)}
    {value.sheets?.map(sheet => <section key={sheet.sheet}><h4>{sheet.sheet} · 第 {sheet.startRow}–{Math.min(sheet.endRow, sheet.totalRows)} 行</h4><div className="tableScroll"><table><thead><tr><th>单元格</th><th>值 / 已保存缓存</th><th>公式</th></tr></thead><tbody>{sheet.rows.flat().slice(0, 300).map(cell => <tr key={cell.cell}><td>{cell.cell}</td><td>{cell.value == null ? '无值' : String(cell.value)}</td><td>{cell.formula || '—'}</td></tr>)}</tbody></table></div>{(sheet.hasMore || sheet.rows.flat().length > 300) && <p>这里只展示部分单元格，请让 Agent 按工作表和行范围继续读取。</p>}</section>)}
    {value.paragraphs?.slice(0, 100).map(p => <p key={p.paragraph}><small>段落 {p.paragraph}</small> {p.text}</p>)}
    {(value.hasMore || value.paragraphs?.length > 100) && <p>这里只显示部分内容，可让 Agent 按{value.kind==='pdf'?'页码':'段落'}范围继续读取；精确版式请打开文件核对。</p>}
    {value.tables?.map(t => <section key={t.table}><h4>表格 {t.table}</h4><div className="tableScroll"><table><tbody>{t.rows.slice(0, 100).map((row, i) => <tr key={i}>{row.map((cell, j) => <td key={j}>{cell}</td>)}</tr>)}</tbody></table></div>{(t.rows.length>100 || t.hasMore) && <p>本表只展示部分行，请按表格编号和行范围继续读取。</p>}</section>)}
    {value.pages?.map(p => <section key={p.page}><h4>第 {p.page} 页 · {p.coverage === 'needs_ocr' ? '需要 OCR，未读取' : p.coverage === 'ocr_needs_review' ? 'OCR 结果，需要复核' : '文本层'}</h4><p className="documentText">{p.text}</p></section>)}
  </div>;
}
