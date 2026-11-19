/** CSV helpers shared by the admin exports. */

export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : String(value)
  // Guard against spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = "'" + s
  return `"${s.replace(/"/g, '""')}"`
}

export function toCSV(rows: unknown[][]): string {
  // BOM so Excel reads UTF-8 correctly
  return '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
}

export function csvResponse(filename: string, rows: unknown[][]): Response {
  return new Response(toCSV(rows), {
    headers: {
      'Content-Type': 'text/csv;charset=utf-8;',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store'
    }
  })
}

export function stamp(): string {
  return new Date().toISOString().slice(0, 10)
}
