import { useEffect, useRef, useState } from 'react'
import './App.css'

type ModuleId = 'dashboard' | 'upload' | 'reports' | 'history'
type UploadState = 'idle' | 'selected' | 'uploading' | 'error'
type WorkflowPage = 'upload' | 'category' | 'product' | 'saving'
type UploadChannel = 'DSG' | 'SFH' | 'Direct Sales'

type ReviewRow = {
  row_id: number
  order_number: string | number | null
  product_name: string | null
  original_category: string
  amount: number | string | null
  is_combo: boolean
}
type SplitPart = { category: string; amount: string }
type ProductGroup = {
  group_id: string
  row_ids: number[]
  standard_name: string
  variations: string[]
  record_count: number
}
type HistoryRecord = {
  upload_id: string
  file_name: string
  channel: string
  uploaded_at: string
  uploaded_by: string
  total_records: number
  upload_status: string
}
type DirectUnmatched = {
  invoice_records: Record<string, unknown>[]
  inventory_records: Record<string, unknown>[]
}
type KpiCardData = {
  id: string
  title: string
  subtitle: string
  total: number
  breakdown: { label: string; value: number }[]
  trend: number[]
  previous_total?: number
  previous_period_label?: string
  previous_has_data?: boolean
}
type DashboardData = {
  selected_channel: string
  selected_grain: string
  selected_period: string
  available_years: number[]
  category_performance: {
    category: string
    current: { plan: number; actual: number }
    comparison: { plan: number; actual: number }
  }[]
  product_performance: {
    channels: {
      id: string
      label: string
      item_label: string
      top: { name: string; amount: number }[]
      bottom: { name: string; amount: number }[]
    }[]
  }
  customer_performance: {
    total_customers: number
    unique_customers: number
    repeat_customers: number
    unique_percent: number
    repeat_percent: number
  }
  state_performance: { state: string; amount: number }[]
  direct_sales_performance: {
    current: Record<string, number>
    comparison: Record<string, number>
  }
  channel_wise_performance: {
    current: Record<string, number>
    comparison: Record<string, number>
  }
  sales_trend: {
    mode: 'channel' | 'month'
    points: { label: string; value: number }[]
  }
  filters: { id: string; label: string }[]
  cards: KpiCardData[]
}

type TimeSelection = {
  grain: 'monthly' | 'quarterly' | 'yearly'
  period: string
}

const months = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const quarters = [
  'Q1 (Jan, Feb, Mar)',
  'Q2 (Apr, May, Jun)',
  'Q3 (Jul, Aug, Sep)',
  'Q4 (Oct, Nov, Dec)',
]

// Covers the full Digital Online group (DSG + SFH + Amazon). Amazon actuals
// are not integrated yet, so achievement will understate real performance.
const TOTAL_SALES_MONTHLY_PLAN = 500000
const CHANNEL_MONTHLY_PLANS = {
  digitalOnline: 300000,
  stallSales: 100000,
  directSales: 50000,
  bulkSales: 50000,
  totalSales: 500000,
  languageLab: 125000,
  ott: 200000,
  grandTotal: 825000,
}

function getPlanForGrain(monthlyPlan: number, grain: TimeSelection['grain'], period = '') {
  if (grain === 'monthly') return monthlyPlan * Math.max(period.split(',').filter(Boolean).length, 1)
  if (grain === 'quarterly') return monthlyPlan * 3
  if (grain === 'yearly') return monthlyPlan * 12
  return monthlyPlan
}

function planMonthsForGrain(grain: TimeSelection['grain'], period = '') {
  if (grain === 'monthly') return Math.max(period.split(',').filter(Boolean).length, 1)
  if (grain === 'quarterly') return 3
  if (grain === 'yearly') {
    const month = new Date().getMonth() + 1
    return month >= 4 ? month - 3 : month + 9
  }
  return 1
}

const modules: { id: ModuleId; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { id: 'upload', label: 'Upload center', icon: 'upload' },
  { id: 'reports', label: 'Report center', icon: 'report' },
  { id: 'history', label: 'Upload history', icon: 'history' },
]

const channels = [
  { name: 'DSG', status: 'Available', tone: 'indigo' },
  { name: 'SFH', status: 'Available', tone: 'violet' },
  { name: 'Amazon', status: 'Coming soon', tone: 'orange' },
  { name: 'Direct Sales', status: 'Available', tone: 'teal' },
]

const channelPath = (channel: UploadChannel) => channel === 'Direct Sales' ? 'direct-sales' : channel.toLowerCase()

function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const escape = (value: string | number) => {
    const text = String(value)
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
  }
  const csv = [headers, ...rows].map((row) => row.map(escape).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
    upload: <><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" /><path d="M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" /></>,
    report: <><path d="M5 3h11l3 3v15H5z" /><path d="M15 3v4h4M8 16v2m4-6v6m4-9v9" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 4v4h4m5-1v5l3 2" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    file: <><path d="M6 2h8l4 4v16H6z" /><path d="M14 2v5h5M9 13h6m-6 4h4" /></>,
    cloud: <><path d="M7 18h10a4 4 0 0 0 .4-8A6 6 0 0 0 6 8.5 4.8 4.8 0 0 0 7 18Z" /><path d="m9 13 3-3 3 3m-3-3v7" /></>,
    x: <><path d="m7 7 10 10M17 7 7 17" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></>,
    logout: <><path d="M10 4H5v16h5m5-4 4-4-4-4m4 4H9" /></>,
  }
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function Placeholder({ title }: { title: string }) {
  return (
    <div className="placeholder">
      <div className="placeholder-icon"><Icon name="report" size={28} /></div>
      <h2>{title}</h2>
      <p>This module is independent and ready for its implementation step.</p>
    </div>
  )
}

type ReportType = 'summary' | 'channel' | 'category' | 'product'

function ReportCenter() {
  const today = new Date()
  const [grain, setGrain] = useState<'monthly' | 'yearly'>('monthly')
  const [month, setMonth] = useState(String(today.getMonth() + 1))
  const [year, setYear] = useState(today.getFullYear())
  const [reportType, setReportType] = useState<ReportType>('summary')
  const reportNames: Record<ReportType, string> = {
    summary: 'Summary Report', channel: 'Channel Wise Performance Report',
    category: 'Category Wise Performance Report', product: 'Product Wise Performance Report',
  }
  const selectedMonths = month.split(',').filter(Boolean).map(Number).sort((a, b) => a - b)
  const periodLabel = grain === 'monthly'
    ? `${selectedMonths.map((value) => months[value - 1].slice(0, 3)).join(', ')} - ${String(year).slice(-2)}`
    : String(year)
  const download = (dataset: 'report' | 'clean') => {
    const params = new URLSearchParams({ grain, period: grain === 'monthly' ? month : String(year), year: String(year), report_type: reportType, dataset })
    window.location.assign(`/api/reports/download?${params}`)
  }

  return <div className="content report-center">
    <section className="intro"><div><span className="section-kicker">Reporting & exports</span><h2>Sales Report Center</h2><p>Build monthly or yearly MIS reports and download filtered source data or a presentation-ready Excel workbook.</p></div></section>
    <section className="report-filter-card">
      <div className="report-filter-grid">
        <label><span>Period type</span><select value={grain} onChange={(event) => setGrain(event.target.value as 'monthly' | 'yearly')}><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
        {grain === 'monthly' && <label><span>Month (single or multiple)</span><MonthChecklistDropdown value={month} onChange={setMonth} /></label>}
        <label><span>Year</span><select value={year} onChange={(event) => setYear(Number(event.target.value))}>{Array.from({ length: 6 }, (_, index) => today.getFullYear() - index).map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="report-type-field"><span>Report</span><select value={reportType} onChange={(event) => setReportType(event.target.value as ReportType)}>{Object.entries(reportNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      </div>
    </section>
    <section className="report-preview-card report-export-card">
      <div className="report-preview-head"><div><span className="section-kicker">Excel export</span><h3>{reportNames[reportType]}</h3><p>{periodLabel} · The requested report formatting will be applied inside the downloaded Excel file.</p></div><span className="format-pill">XLSX</span></div>
      <div className="report-download-footer"><div><strong>Ready to export</strong><span>Download the selected report or its standardized cleaned dataset.</span></div><div><button className="secondary-download" onClick={() => download('report')}>↓ Download Report</button><button className="primary-download" onClick={() => download('clean')}>↓ Download Cleaned Dataset</button></div></div>
    </section>
  </div>
}

type TrendDirection = 'up' | 'down' | 'neutral'

function trendDetails(values: number[]): { direction: TrendDirection; label: string } {
  if (values.length < 2) return { direction: 'neutral', label: '—' }
  const previous = values[values.length - 2]
  const latest = values[values.length - 1]
  if (previous === 0) return { direction: 'neutral', label: '—' }
  const change = ((latest - previous) / Math.abs(previous)) * 100
  if (Math.abs(change) < 0.05) return { direction: 'neutral', label: '0.0%' }
  return {
    direction: change > 0 ? 'up' : 'down',
    label: `${change > 0 ? '+' : ''}${change.toFixed(1)}%`,
  }
}

function periodComparison(card: KpiCardData): { direction: TrendDirection; label: string } {
  const previous = card.previous_total ?? 0
  const previousLabel = card.previous_period_label ?? 'previous period'
  if (!card.previous_has_data || card.total === previous) {
    return { direction: 'neutral', label: `vs ${previousLabel}` }
  }
  if (previous === 0) {
    return { direction: card.total > 0 ? 'up' : 'down', label: `New vs ${previousLabel}` }
  }
  const change = Math.round(((card.total - previous) / previous) * 100)
  return {
    direction: change > 0 ? 'up' : 'down',
    label: `${Math.abs(change)}% vs ${previousLabel}`,
  }
}

function Sparkline({ values, direction }: { values: number[]; direction: TrendDirection }) {
  const width = 220
  const height = 48
  const insufficient = values.length < 2
  const allZero = values.length > 0 && values.every((value) => value === 0)
  if (insufficient || allZero) {
    return <svg className={`sparkline ${direction} empty`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label="Insufficient trend data"><line x1="0" y1={height / 2} x2={width} y2={height / 2} /></svg>
  }
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const range = maximum - minimum || 1
  const points = values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width
    const y = height - 5 - ((value - minimum) / range) * (height - 12)
    return { x, y }
  })
  const path = points.slice(0, -1).map((point, index) => {
    const before = points[Math.max(0, index - 1)]
    const next = points[index + 1]
    const after = points[Math.min(points.length - 1, index + 2)]
    const control1 = { x: point.x + (next.x - before.x) / 6, y: point.y + (next.y - before.y) / 6 }
    const control2 = { x: next.x - (after.x - point.x) / 6, y: next.y - (after.y - point.y) / 6 }
    return `C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${next.x} ${next.y}`
  }).join(' ')
  const last = points[points.length - 1]
  return <svg className={`sparkline ${direction}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    <path d={`M ${points[0].x} ${points[0].y} ${path}`} />
    <circle cx={last.x} cy={last.y} r="3.5" />
  </svg>
}

function SalesTrendChart({ trend, loading }: { trend: DashboardData['sales_trend']; loading: boolean }) {
  const width = 860
  const height = 330
  const padding = { top: 38, right: 34, bottom: 82, left: 82 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  const pointInset = 34
  const pointWidth = chartWidth - pointInset * 2
  const maximum = Math.max(...trend.points.map((point) => point.value), 1)
  const magnitude = 10 ** Math.floor(Math.log10(maximum))
  const step = Math.max(magnitude, Math.ceil(maximum / (4 * magnitude)) * magnitude)
  const axisMaximum = Math.ceil(maximum / step) * step
  const ticks = Array.from({ length: 5 }, (_, index) => (axisMaximum / 4) * index)
  const points = trend.points.map((point, index) => ({
    ...point,
    x: padding.left + (trend.points.length === 1
      ? chartWidth / 2
      : pointInset + (index / (trend.points.length - 1)) * pointWidth),
    y: padding.top + chartHeight - (point.value / axisMaximum) * chartHeight,
  }))
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
  const number = (value: number) => Math.round(value).toLocaleString('en-IN')
  return <section className={`sales-trend-card ${loading ? 'is-loading' : ''}`}>
    <div className="sales-trend-head"><div><span className="section-kicker">Sales movement</span><h3>Sales Trend</h3></div><span>{trend.mode === 'channel' ? 'By channel' : 'By month'}</span></div>
    {points.length ? <div className="sales-trend-scroll"><svg className="sales-trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Sales trend ${trend.mode === 'channel' ? 'by channel' : 'by month'}`}>
      {ticks.map((tick) => {
        const y = padding.top + chartHeight - (tick / axisMaximum) * chartHeight
        return <g key={tick}><line className="sales-grid-line" x1={padding.left} x2={width - padding.right} y1={y} y2={y} /><text className="sales-y-label" x={padding.left - 12} y={y + 4}>{number(tick)}</text></g>
      })}
      <text className="sales-axis-title" transform={`translate(20 ${padding.top + chartHeight / 2}) rotate(-90)`}>Sales</text>
      <path className="sales-trend-line" d={path} />
      {points.map((point) => <g key={point.label}>
        <circle className="sales-trend-point" cx={point.x} cy={point.y} r="5"><title>{point.label}: {number(point.value)}</title></circle>
        <text className="sales-value-label" x={point.x} y={Math.max(point.y - 13, 16)} textAnchor="middle">{number(point.value)}</text>
        <text className="sales-x-label" x={point.x} y={height - padding.bottom + 25} textAnchor="end" transform={`rotate(-55 ${point.x} ${height - padding.bottom + 25})`}>{point.label}</text>
      </g>)}
      <text className="sales-axis-title" x={padding.left + chartWidth / 2} y={height - 8} textAnchor="middle">{trend.mode === 'channel' ? 'Channel' : 'Period'}</text>
    </svg></div> : <div className="detail-empty detail-empty-large">No sales trend data available</div>}
  </section>
}

function MonthChecklistDropdown({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const selected = value.split(',').filter(Boolean)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(selected)
  const draftSet = new Set(draft)
  const selectedLabels = selected.map((month) => months[Number(month) - 1])
  const summary = selectedLabels.length <= 3
    ? selectedLabels.join(', ')
    : `${selectedLabels.slice(0, 3).join(', ')} +${selectedLabels.length - 3}`

  const closeWithoutSaving = () => {
    setDraft(selected)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeWithoutSaving()
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeWithoutSaving()
    }
    document.addEventListener('mousedown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, value])

  const toggleMonth = (month: string) => {
    const next = draftSet.has(month)
      ? draft.filter((item) => item !== month)
      : [...draft, month].sort((a, b) => Number(a) - Number(b))
    setDraft(next)
    if (draft.length === 0 && next.length === 1) {
      onChange(next[0])
      setOpen(false)
    }
  }

  return <div className={`month-checklist ${open ? 'open' : ''}`} ref={rootRef}>
    <button type="button" className="month-checklist-trigger" onClick={() => { setDraft(selected); setOpen((current) => !current) }} aria-haspopup="listbox" aria-expanded={open}>{summary}</button>
    {open && <div className="month-checklist-menu">
      <div className="month-checklist-actions">
        <button type="button" onClick={() => setDraft(months.map((_, index) => String(index + 1)))}>Select All</button>
        <button type="button" onClick={() => setDraft([])}>Clear All</button>
      </div>
      {months.map((month, index) => {
        const monthValue = String(index + 1)
        return <label key={month}>
          <input
            type="checkbox"
            checked={draftSet.has(monthValue)}
            onChange={() => toggleMonth(monthValue)}
          />
          <span>{month}</span>
        </label>
      })}
      <div className="month-checklist-footer">
        <button type="button" onClick={closeWithoutSaving}>Cancel</button>
        <button type="button" disabled={!draft.length} onClick={() => { onChange(draft.join(',')); setOpen(false) }}>Apply</button>
      </div>
    </div>
    }
  </div>
}

function CategoryWiseSales({
  rows,
  loading,
}: {
  rows: DashboardData['category_performance']
  loading: boolean
}) {
  const colors = ['#dc613e', '#8174e8', '#28a17b', '#d84e79']
  const totalPlan = rows.reduce((sum, row) => sum + row.current.plan, 0)
  const totalActual = rows.reduce((sum, row) => sum + row.current.actual, 0)
  const formatMoney = (value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`
  let startAngle = -90
  const point = (angle: number, radius: number) => {
    const radians = (angle * Math.PI) / 180
    return { x: 110 + radius * Math.cos(radians), y: 110 + radius * Math.sin(radians) }
  }
  const slices = rows.map((row, index) => {
    const percentage = totalActual ? (row.current.actual / totalActual) * 100 : 0
    const sweep = (percentage / 100) * 360
    const endAngle = startAngle + sweep
    const start = point(startAngle, 88)
    const end = point(endAngle, 88)
    const label = point(startAngle + sweep / 2, 56)
    const path = sweep >= 359.999
      ? ''
      : `M 110 110 L ${start.x} ${start.y} A 88 88 0 ${sweep > 180 ? 1 : 0} 1 ${end.x} ${end.y} Z`
    const slice = { row, color: colors[index], percentage, path, label, full: sweep >= 359.999 }
    startAngle = endAngle
    return slice
  })
  const leader = rows.reduce<typeof rows[number] | null>(
    (highest, row) => !highest || row.current.actual > highest.current.actual ? row : highest,
    null,
  )
  const leaderPercentage = leader && totalActual ? (leader.current.actual / totalActual) * 100 : 0

  return <section className={`category-sales-visual ${loading ? 'is-loading' : ''}`}>
    <div className="category-performance-head">
      <div><span className="section-kicker">Category contribution</span><h3>Category Wise Sales</h3></div>
    </div>
    <div className="category-sales-layout">
      <div className="category-sales-table-wrap">
        <table className="category-sales-table">
          <thead><tr><th>Category</th><th>Plan</th><th>Actual</th><th>% Contribution</th></tr></thead>
          <tbody>
            {rows.map((row) => <tr key={row.category}>
              <th>{row.category}</th>
              <td>{formatMoney(row.current.plan)}</td>
              <td>{formatMoney(row.current.actual)}</td>
              <td>{totalActual ? ((row.current.actual / totalActual) * 100).toFixed(1) : '0.0'}%</td>
            </tr>)}
            <tr className="performance-total"><th>Total</th><td>{formatMoney(totalPlan)}</td><td>{formatMoney(totalActual)}</td><td>{totalActual ? '100%' : '0%'}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="category-pie-panel">
        <div className="category-pie-legend">
          {slices.map((slice) => <span key={slice.row.category}><i style={{ background: slice.color }} />{slice.row.category}</span>)}
        </div>
        {totalActual > 0 ? <svg className="category-pie" viewBox="0 0 220 220" role="img" aria-label="Category actual sales contribution pie chart">
          {slices.filter((slice) => slice.row.current.actual > 0).map((slice) => <g key={slice.row.category}>
            {slice.full ? <circle cx="110" cy="110" r="88" fill={slice.color} /> : <path d={slice.path} fill={slice.color} />}
            {slice.percentage >= 5 && <text x={slice.label.x} y={slice.label.y} textAnchor="middle" dominantBaseline="middle">{Math.round(slice.percentage)}%</text>}
          </g>)}
        </svg> : <div className="category-pie-empty">No sales data for this selection</div>}
      </div>
    </div>
    <div className="category-sales-insight">
      <span>✦</span>
      <p>{leader && totalActual > 0
        ? <><strong>{leader.category}</strong> contributed <strong>{formatMoney(leader.current.actual)}</strong>, accounting for <strong>{leaderPercentage.toFixed(1)}%</strong> of total sales of <strong>{formatMoney(totalActual)}</strong>.</>
        : 'No category sales were recorded for the selected period and channel.'}</p>
    </div>
  </section>
}

function ProductRankings({
  data,
  loading,
}: {
  data: DashboardData['product_performance']
  loading: boolean
}) {
  const money = (value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`
  const list = (items: { name: string; amount: number }[], tone: 'top' | 'bottom') =>
    items.length ? items.map((item, index) => <div className="product-rank-row" key={`${item.name}-${index}`}>
      <span className="product-rank-number">{index + 1}</span>
      <span className="product-rank-name" title={item.name}>{item.name}</span>
      <strong className={tone}>{money(item.amount)}</strong>
    </div>) : <div className="product-rank-empty">No product sales for this selection</div>

  return <section className={`product-rankings ${loading ? 'is-loading' : ''}`}>
    <div className="category-performance-head">
      <div><span className="section-kicker">Product performance</span><h3>Top 5 / Bottom 5 Products</h3></div>
    </div>
    <div className="product-channel-sections">
      {data.channels.map((channel) => <article className="product-channel-section" key={channel.id}>
        <div className="product-channel-heading"><strong>{channel.label}</strong><span>{channel.item_label}</span></div>
        <div className="product-rankings-grid">
          <div className="product-rank-list">
            <div className="product-rank-title top"><span>↑</span><div><strong>Top 5</strong><small>Highest sales</small></div></div>
            {list(channel.top, 'top')}
          </div>
          <div className="product-rank-list">
            <div className="product-rank-title bottom"><span>↓</span><div><strong>Bottom 5</strong><small>Lowest sales</small></div></div>
            {list(channel.bottom, 'bottom')}
          </div>
        </div>
      </article>)}
    </div>
  </section>
}

function TopProductByChannel({
  channels,
  loading,
}: {
  channels: DashboardData['product_performance']['channels']
  loading: boolean
}) {
  const money = (value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`
  return <section className={`dashboard-detail-card ${loading ? 'is-loading' : ''}`}>
    <div className="detail-card-head"><span className="detail-card-icon">★</span><div><span className="section-kicker">Channel leaders</span><h3>Top Product by Channel</h3></div></div>
    <div className="top-channel-products">
      {channels.map((channel) => {
        const product = channel.top[0]
        return <div className="top-channel-product" key={channel.id}>
          <div><strong>{channel.label}</strong><span>{channel.item_label}</span></div>
          {product ? <><p title={product.name}>{product.name}</p><strong className="top-product-value">{money(product.amount)}</strong></> : <span className="detail-empty">No Data Available</span>}
        </div>
      })}
    </div>
  </section>
}

function CustomersByEmail({
  data,
  loading,
}: {
  data: DashboardData['customer_performance']
  loading: boolean
}) {
  return <section className={`dashboard-detail-card ${loading ? 'is-loading' : ''}`}>
    <div className="detail-card-head"><span className="detail-card-icon">＠</span><div><span className="section-kicker">Customer frequency</span><h3>Customers by Email</h3></div></div>
    {data.total_customers ? <div className="customer-mix">
      <div className="customer-mix-bar" aria-label={`${data.unique_percent}% unique customers and ${data.repeat_percent}% repeat customers`}>
        <span className="unique" style={{ width: `${data.unique_percent}%` }} />
        <span className="repeat" style={{ width: `${data.repeat_percent}%` }} />
      </div>
      <div className="customer-mix-values">
        <div><span><i className="unique" />Unique Customers</span><strong>{data.unique_percent.toFixed(1)}%</strong><small>{data.unique_customers.toLocaleString('en-IN')} customers</small></div>
        <div><span><i className="repeat" />Repeat Customers</span><strong>{data.repeat_percent.toFixed(1)}%</strong><small>{data.repeat_customers.toLocaleString('en-IN')} customers</small></div>
      </div>
      <p>Total identified customers: <strong>{data.total_customers.toLocaleString('en-IN')}</strong></p>
    </div> : <div className="detail-empty detail-empty-large">No Data Available</div>}
  </section>
}

function StateWisePerformance({ rows, loading }: { rows: DashboardData['state_performance']; loading: boolean }) {
  const visible = rows.slice(0, 10)
  const maximum = Math.max(...visible.map((row) => row.amount), 1)
  const total = rows.reduce((sum, row) => sum + row.amount, 0)
  return <section className={`dashboard-detail-card state-performance ${loading ? 'is-loading' : ''}`}>
    <div className="detail-card-head"><span className="detail-card-icon">⌖</span><div><span className="section-kicker">Geographic sales</span><h3>State Wise Performance</h3></div></div>
    {visible.length ? <>
      <div className="state-performance-list">
        {visible.map((row, index) => <div className="state-performance-row" key={row.state}>
          <span className="state-rank">{index + 1}</span>
          <div><div><span>{row.state}</span><strong>{Math.round(row.amount).toLocaleString('en-IN')}</strong></div><div className="state-performance-bar"><span style={{ width: `${Math.max((row.amount / maximum) * 100, row.amount ? 2 : 0)}%` }} /></div></div>
        </div>)}
      </div>
      <div className="state-performance-total"><span>Total sales across {rows.length} locations</span><strong>{Math.round(total).toLocaleString('en-IN')}</strong></div>
    </> : <div className="detail-empty detail-empty-large">No state data available</div>}
  </section>
}

function DashboardPage() {
  const today = new Date()
  const initialMonth = String(today.getMonth() + 1)
  const initialYear = today.getFullYear()
  const previousDate = new Date(initialYear, today.getMonth() - 1, 1)
  const [data, setData] = useState<DashboardData | null>(null)
  const [selected, setSelected] = useState('all')
  const [time, setTime] = useState<TimeSelection>({ grain: 'monthly', period: initialMonth })
  const [activeYear, setActiveYear] = useState(initialYear)
  const [comparison, setComparison] = useState<TimeSelection>({ grain: 'monthly', period: String(previousDate.getMonth() + 1) })
  const [comparisonYear, setComparisonYear] = useState(previousDate.getFullYear())
  const [draftChannel, setDraftChannel] = useState('all')
  const [draftTime, setDraftTime] = useState<TimeSelection>({ grain: 'monthly', period: initialMonth })
  const [draftYear, setDraftYear] = useState(initialYear)
  const [draftComparison, setDraftComparison] = useState<TimeSelection>({ grain: 'monthly', period: String(previousDate.getMonth() + 1) })
  const [draftComparisonYear, setDraftComparisonYear] = useState(previousDate.getFullYear())
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['zero_rated', 'exempted', 'taxable', 'pnl']))

  useEffect(() => {
    let active = true
    const query = new URLSearchParams({ channel: selected, grain: time.grain })
    if (time.period) query.set('period', time.period)
    query.set('year', String(activeYear))
    query.set('comparison_grain', comparison.grain)
    query.set('comparison_period', comparison.period)
    query.set('comparison_year', String(comparisonYear))
    fetch(`/api/dashboard/kpis?${query}`)
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail ?? 'Unable to load dashboard KPIs.')
        return result
      })
      .then((result: DashboardData) => {
        if (active) {
          setData(result)
          setError('')
        }
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load dashboard KPIs.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [selected, time, activeYear, comparison, comparisonYear])

  const applyFilters = () => {
    setLoading(true)
    setSelected(draftChannel)
    setTime(draftTime.grain === 'yearly' ? { ...draftTime, period: String(draftYear) } : draftTime)
    setActiveYear(draftYear)
    setComparison(draftComparison.grain === 'yearly' ? { ...draftComparison, period: String(draftComparisonYear) } : draftComparison)
    setComparisonYear(draftComparisonYear)
  }

  const selectGrain = (grain: TimeSelection['grain']) => {
    setLoading(true)
    setTime({ grain, period: grain === 'monthly' ? initialMonth : grain === 'quarterly' ? String(Math.floor(today.getMonth() / 3) + 1) : String(activeYear) })
  }

  const periodOptions = (selection: TimeSelection) => selection.grain === 'monthly'
    ? months.map((label, index) => ({ value: String(index + 1), label }))
    : selection.grain === 'quarterly'
      ? quarters.map((label, index) => ({ value: String(index + 1), label }))
      : [{ value: selection.period, label: 'Full year' }]

  const number = (value: number) => Math.round(value).toLocaleString('en-IN')
  const variance = (actual: number, plan: number) => actual - plan
  const variancePercent = (actual: number, plan: number) => plan ? ((actual - plan) / plan) * 100 : 0
  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const yearOptions = data
    ? [...new Set([initialYear, initialYear - 1, ...data.available_years])].sort((a, b) => b - a)
    : [initialYear, initialYear - 1]
  const currentPlanMonths = planMonthsForGrain(time.grain, time.period)
  const comparisonPlanMonths = planMonthsForGrain(comparison.grain, comparison.period)
  const channelActual = (period: 'current' | 'comparison', channel: string) =>
    data?.channel_wise_performance[period][channel] ?? 0
  const channelPerformance = [
    { channel: 'Digital Online', monthlyPlan: CHANNEL_MONTHLY_PLANS.digitalOnline, currentActual: channelActual('current', 'Digital Online'), comparisonActual: channelActual('comparison', 'Digital Online') },
    { channel: 'Stall Sales', monthlyPlan: CHANNEL_MONTHLY_PLANS.stallSales, currentActual: channelActual('current', 'Stall Sales'), comparisonActual: channelActual('comparison', 'Stall Sales') },
    { channel: 'Direct Sales', monthlyPlan: CHANNEL_MONTHLY_PLANS.directSales, currentActual: channelActual('current', 'Direct Sales'), comparisonActual: channelActual('comparison', 'Direct Sales') },
    { channel: 'Bulk Sales', monthlyPlan: CHANNEL_MONTHLY_PLANS.bulkSales, currentActual: channelActual('current', 'Bulk Sales'), comparisonActual: channelActual('comparison', 'Bulk Sales') },
    { channel: 'Total Sales', monthlyPlan: CHANNEL_MONTHLY_PLANS.totalSales, currentActual: channelActual('current', 'Total Sales'), comparisonActual: channelActual('comparison', 'Total Sales') },
    { channel: 'Language Lab', monthlyPlan: CHANNEL_MONTHLY_PLANS.languageLab, currentActual: channelActual('current', 'Language Lab'), comparisonActual: channelActual('comparison', 'Language Lab') },
    { channel: 'OTT', monthlyPlan: CHANNEL_MONTHLY_PLANS.ott, currentActual: channelActual('current', 'OTT'), comparisonActual: channelActual('comparison', 'OTT') },
    { channel: 'Grand Total Sales', monthlyPlan: CHANNEL_MONTHLY_PLANS.grandTotal, currentActual: channelActual('current', 'Grand Total Sales'), comparisonActual: channelActual('comparison', 'Grand Total Sales') },
  ]
  const performanceHeaders = [
    'Name',
    'Current Plan', 'Current Actual', 'Current Variance', 'Current Variance %',
    'Comparison Plan', 'Comparison Actual', 'Comparison Variance', 'Comparison Variance %',
  ]
  const downloadCategoryPerformance = () => {
    if (!data) return
    const rows = [...data.category_performance, {
      category: 'Total',
      current: {
        plan: data.category_performance.reduce((sum, row) => sum + row.current.plan, 0),
        actual: data.category_performance.reduce((sum, row) => sum + row.current.actual, 0),
      },
      comparison: {
        plan: data.category_performance.reduce((sum, row) => sum + row.comparison.plan, 0),
        actual: data.category_performance.reduce((sum, row) => sum + row.comparison.actual, 0),
      },
    }]
    downloadCsv(
      `category-wise-performance-${selected}-${time.grain}-${time.period}.csv`,
      performanceHeaders,
      rows.map((row) => [
        row.category,
        row.current.plan, row.current.actual, variance(row.current.actual, row.current.plan), variancePercent(row.current.actual, row.current.plan).toFixed(1),
        row.comparison.plan, row.comparison.actual, variance(row.comparison.actual, row.comparison.plan), variancePercent(row.comparison.actual, row.comparison.plan).toFixed(1),
      ]),
    )
  }
  const downloadChannelPerformance = () => downloadCsv(
    `channel-wise-performance-${selected}-${time.grain}-${time.period}.csv`,
    performanceHeaders,
    channelPerformance.map((row) => {
      const currentPlan = row.monthlyPlan * currentPlanMonths
      const comparisonPlan = row.monthlyPlan * comparisonPlanMonths
      return [
        row.channel,
        currentPlan, row.currentActual, variance(row.currentActual, currentPlan), variancePercent(row.currentActual, currentPlan).toFixed(1),
        comparisonPlan, row.comparisonActual, variance(row.comparisonActual, comparisonPlan), variancePercent(row.comparisonActual, comparisonPlan).toFixed(1),
      ]
    }),
  )

  if (loading && !data) return <div className="content"><div className="dashboard-loading">Calculating reviewed sales KPIs…</div></div>
  return (
    <div className="content dashboard-page">
      <section className="intro"><div><span className="section-kicker">Reviewed sales data</span><h2>Sales KPI Dashboard</h2><p>Consolidated performance with channel filtering, category breakdowns, and monthly trends.</p></div></section>
      {error && <div className="error-message dashboard-error"><Icon name="info" size={18} /><span>{error}</span></div>}
      {data && <>
        <div className="comparison-panel">
          <div className="comparison-panel-head"><div><span className="filter-label">Dashboard comparison</span><h3>Compare sales periods</h3></div><button className="apply-filter-button" onClick={applyFilters}>Apply</button></div>
          <div className="comparison-selectors">
            {[
              { title: 'Primary period', value: draftTime, year: draftYear, setValue: setDraftTime, setYear: setDraftYear },
              { title: 'Comparison period', value: draftComparison, year: draftComparisonYear, setValue: setDraftComparison, setYear: setDraftComparisonYear },
            ].map((item) => <div className="comparison-period" key={item.title}>
              <strong>{item.title}</strong>
              <label><span>Period type</span><select value={item.value.grain} onChange={(event) => { const grain = event.target.value as TimeSelection['grain']; item.setValue({ grain, period: grain === 'monthly' ? initialMonth : grain === 'quarterly' ? String(Math.floor(today.getMonth() / 3) + 1) : String(item.year) }) }}><option value="monthly">Month</option><option value="quarterly">Quarter</option><option value="yearly">Year</option></select></label>
              <div className="comparison-field"><span>Value</span>{item.value.grain === 'monthly'
                ? <MonthChecklistDropdown value={item.value.period} onChange={(period) => item.setValue({ ...item.value, period })} />
                : <select value={item.value.period} onChange={(event) => item.setValue({ ...item.value, period: event.target.value })}>{periodOptions(item.value).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>}
              </div>
              <label><span>Year</span><select value={item.year} onChange={(event) => { const year = Number(event.target.value); item.setYear(year); if (item.value.grain === 'yearly') item.setValue({ ...item.value, period: String(year) }) }}>{yearOptions.map((year) => <option key={year} value={year}>{year}</option>)}</select></label>
            </div>)}
          </div>
          <div className="comparison-channels"><span className="filter-label">Channel</span><div className="dashboard-filters">
            {[...data.filters, { id: 'amazon', label: 'Amazon' }].map((filter) => {
              const unavailable = filter.id === 'amazon'
              return <button className={draftChannel === filter.id ? 'active' : ''} disabled={unavailable} title={unavailable ? 'Not integrated' : undefined} key={filter.id} onClick={() => {
                setDraftChannel(filter.id)
                setLoading(true)
                setSelected(filter.id)
              }}>{filter.label}</button>
            })}
          </div></div>
        </div>
        <div className="dashboard-filter-groups">
          <div className="filter-group">
            <span className="filter-label">Channel</span>
            <div className="dashboard-filters">
              {data.filters.map((filter) => <button className={selected === filter.id ? 'active' : ''} key={filter.id} onClick={() => { setLoading(true); setSelected(filter.id) }}>{filter.label}</button>)}
            </div>
          </div>
          <div className="filter-group">
            <span className="filter-label">Time grain</span>
            <div className="time-filter-controls">
              <div className="dashboard-filters">
                {([['monthly', 'Monthly'], ['quarterly', 'Quarterly'], ['yearly', 'Yearly']] as const).map(([id, label]) => <button className={time.grain === id ? 'active' : ''} key={id} onClick={() => selectGrain(id)}>{label}</button>)}
              </div>
              <select
                className="time-period-select"
                aria-label={`Select ${time.grain} period`}
                value={time.period}
                onChange={(event) => { setLoading(true); setTime({ ...time, period: event.target.value }) }}
              >
                {!time.period && <option value="">Loading periods…</option>}
                {time.grain === 'monthly' && months.map((month, index) => <option key={month} value={index + 1}>{month}</option>)}
                {time.grain === 'quarterly' && quarters.map((quarter, index) => <option key={quarter} value={index + 1}>{quarter}</option>)}
                {time.grain === 'yearly' && data.available_years.map((year) => <option key={year} value={year}>{year}</option>)}
              </select>
            </div>
          </div>
        </div>
        <section className={`kpi-grid ${selected !== 'all' ? 'channel-view' : ''} ${loading ? 'is-loading' : ''}`}>
          {data.cards.map((card) => {
            const isExpanded = expanded.has(card.id)
            const trend = trendDetails(card.trend)
            const isAllChannelsPnl = selected === 'all' && card.id === 'pnl'
            const isAllChannelsTaxCard = selected === 'all' && ['zero_rated', 'exempted', 'taxable'].includes(card.id)
            const comparison = periodComparison(card)
            const plan = getPlanForGrain(TOTAL_SALES_MONTHLY_PLAN, time.grain, time.period)
            const achievement = Math.round((card.total / plan) * 100)
            const achievementTone = achievement >= 100 ? 'green' : achievement >= 80 ? 'amber' : 'red'
            const roundedTotal = Math.round(card.total)
            const displayBreakdown = card.breakdown.map((item) => ({
              ...item,
              value: Math.round(item.value),
            }))
            if (displayBreakdown.length) {
              const difference = roundedTotal - displayBreakdown.reduce((sum, item) => sum + item.value, 0)
              const adjustmentIndex = displayBreakdown.reduce(
                (largest, item, index, items) => Math.abs(item.value) > Math.abs(items[largest].value) ? index : largest,
                0,
              )
              displayBreakdown[adjustmentIndex].value += difference
            }
            if (selected !== 'all') {
              const channelName = selected === 'dsg' ? 'DSG' : selected === 'sfh' ? 'SFH' : 'Direct Sales'
              const maximumCategory = Math.max(...displayBreakdown.map((item) => item.value), 1)
              const categoryTone = (label: string) => label.includes('Books') ? 'orange' : label.includes('Audio') ? 'teal' : label.includes('Pen') ? 'pink' : 'violet'
              const cardIcon = card.id === 'zero_rated' ? '⊙' : card.id === 'exempted' ? '▧' : card.id === 'taxable' ? '%' : '▣'
              return <article className="kpi-card channel-kpi-card" key={card.id}>
                <div className="channel-kpi-head">
                  <span><i>{cardIcon}</i>{card.title}</span>
                  <span className={`delta-badge comparison-badge ${comparison.direction}`}>
                    <span className="delta-arrow">{comparison.direction === 'up' ? '↑' : comparison.direction === 'down' ? '↓' : '—'}</span>
                    {comparison.label}
                  </span>
                </div>
                <strong className="kpi-value">{number(card.total)}</strong>
                <p>{card.subtitle}, {channelName}</p>
                <div className="channel-category-breakdown">
                  {displayBreakdown.length ? displayBreakdown.map((item) => {
                    const tone = categoryTone(item.label)
                    return <div className="channel-category-row" key={item.label}>
                      <div><span><i className={tone} />{item.label}</span><strong>{number(item.value)}</strong></div>
                      <div className="category-bar"><span className={tone} style={{ width: `${Math.max((item.value / maximumCategory) * 100, item.value ? 7 : 0)}%` }} /></div>
                    </div>
                  }) : <div className="channel-empty-row">No applicable sales</div>}
                </div>
                <div className="channel-kpi-total"><span>Total</span><strong>{number(card.total)}</strong></div>
              </article>
            }
            if (isAllChannelsPnl) {
              return <article className="kpi-card" key={card.id}>
                <button className="kpi-card-head" onClick={() => toggle(card.id)} aria-expanded={isExpanded}>
                  <span>{card.title}</span>
                  <span className="kpi-head-actions">
                    <span className={`plan-badge ${achievementTone}`}>{achievement}% of plan</span>
                    <span className={`kpi-chevron ${isExpanded ? 'open' : ''}`}>⌃</span>
                  </span>
                </button>
                <div className="kpi-value-row">
                  <strong className="kpi-value">{number(card.total)} <span className="plan-value">/ {number(plan)}</span></strong>
                </div>
                <p>{card.subtitle}</p>
                <div className="plan-progress" role="progressbar" aria-label="Sales plan achievement" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(Math.max(achievement, 0), 100)}>
                  <span className={achievementTone} style={{ width: `${Math.min(Math.max(achievement, 0), 100)}%` }} />
                </div>
                {isExpanded && <div className="kpi-breakdown">
                  {displayBreakdown.length ? displayBreakdown.map((item) => <div key={item.label}><span>{item.label}</span><strong>{number(item.value)}</strong></div>) : <div className="no-breakdown"><span>No applicable sales</span><strong>0</strong></div>}
                  <div><span>Amazon</span><span className="not-integrated">Not integrated</span></div>
                  <div className="kpi-total"><span>Total</span><strong>{number(card.total)}</strong></div>
                </div>}
              </article>
            }
            if (isAllChannelsTaxCard) {
              return <article className="kpi-card" key={card.id}>
                <button className="kpi-card-head" onClick={() => toggle(card.id)} aria-expanded={isExpanded}>
                  <span>{card.title}</span><span className={`kpi-chevron ${isExpanded ? 'open' : ''}`}>⌃</span>
                </button>
                <div className="kpi-value-row">
                  <strong className="kpi-value">{number(card.total)}</strong>
                  <span className={`delta-badge comparison-badge ${comparison.direction}`}>
                    <span className="delta-arrow">{comparison.direction === 'up' ? '↑' : comparison.direction === 'down' ? '↓' : '—'}</span>
                    {comparison.label}
                  </span>
                </div>
                <p>{card.subtitle}</p>
                {isExpanded && <div className="kpi-breakdown">
                  {displayBreakdown.length ? displayBreakdown.map((item) => <div key={item.label}><span>{item.label}</span><strong>{number(item.value)}</strong></div>) : <div className="no-breakdown"><span>No applicable sales</span><strong>0</strong></div>}
                  <div className="kpi-total"><span>Total</span><strong>{number(card.total)}</strong></div>
                </div>}
              </article>
            }
            return <article className="kpi-card" key={card.id}>
              <button className="kpi-card-head" onClick={() => toggle(card.id)} aria-expanded={isExpanded}>
                <span>{card.title}</span><span className={`kpi-chevron ${isExpanded ? 'open' : ''}`}>⌃</span>
              </button>
              <div className="kpi-value-row"><strong className="kpi-value">{number(card.total)}</strong>{card.trend.length >= 2 && <span className={`delta-badge ${trend.direction}`}><span className="delta-arrow">{trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : ''}</span>{trend.label}</span>}</div>
              <p>{card.subtitle}</p>
              {card.trend.length >= 2 ? <Sparkline values={card.trend} direction={trend.direction} /> : <div className="trend-insufficient">Not enough data at this grain yet</div>}
              {isExpanded && <div className="kpi-breakdown">
                {displayBreakdown.length ? displayBreakdown.map((item) => <div key={item.label}><span>{item.label}</span><strong>{number(item.value)}</strong></div>) : <div className="no-breakdown"><span>No applicable sales</span><strong>0</strong></div>}
                <div className="kpi-total"><span>Total</span><strong>{number(card.total)}</strong></div>
              </div>}
            </article>
          })}
        </section>
        <SalesTrendChart trend={data.sales_trend} loading={loading} />
        <div className="dashboard-visual-grid">
        <section className={`category-performance ${loading ? 'is-loading' : ''}`}>
          <div className="category-performance-head">
            <div><span className="section-kicker">Sales mix analysis</span><h3>Category Wise Performance</h3></div>
            <button className="table-download-button" type="button" onClick={downloadCategoryPerformance}>↓ Download CSV</button>
          </div>
          <div className="category-performance-scroll">
            <table className="category-performance-table">
              <thead>
                <tr><th rowSpan={2}>Category</th><th colSpan={4}>Current Period</th><th colSpan={4}>Comparison Period</th></tr>
                <tr><th>Plan</th><th>Actual</th><th>Var.</th><th>Var.%</th><th>Plan</th><th>Actual</th><th>Var.</th><th>Var.%</th></tr>
              </thead>
              <tbody>
                {[...data.category_performance, {
                  category: 'Total',
                  current: {
                    plan: data.category_performance.reduce((sum, row) => sum + row.current.plan, 0),
                    actual: data.category_performance.reduce((sum, row) => sum + row.current.actual, 0),
                  },
                  comparison: {
                    plan: data.category_performance.reduce((sum, row) => sum + row.comparison.plan, 0),
                    actual: data.category_performance.reduce((sum, row) => sum + row.comparison.actual, 0),
                  },
                }].map((row) => {
                  const currentVariance = variance(row.current.actual, row.current.plan)
                  const comparisonVariance = variance(row.comparison.actual, row.comparison.plan)
                  return <tr className={row.category === 'Total' ? 'performance-total' : ''} key={row.category}>
                    <th>{row.category}</th>
                    <td>{number(row.current.plan)}</td><td>{number(row.current.actual)}</td>
                    <td className={currentVariance >= 0 ? 'positive' : 'negative'}>{currentVariance >= 0 ? '+' : ''}{number(currentVariance)}</td>
                    <td className={currentVariance >= 0 ? 'positive' : 'negative'}>{variancePercent(row.current.actual, row.current.plan).toFixed(1)}%</td>
                    <td>{number(row.comparison.plan)}</td><td>{number(row.comparison.actual)}</td>
                    <td className={comparisonVariance >= 0 ? 'positive' : 'negative'}>{comparisonVariance >= 0 ? '+' : ''}{number(comparisonVariance)}</td>
                    <td className={comparisonVariance >= 0 ? 'positive' : 'negative'}>{variancePercent(row.comparison.actual, row.comparison.plan).toFixed(1)}%</td>
                  </tr>
                })}
              </tbody>
            </table>
          </div>
        </section>
        <section className={`category-performance channel-performance ${loading ? 'is-loading' : ''}`}>
          <div className="category-performance-head">
            <div><span className="section-kicker">Channel analysis</span><h3>Channel Wise Performance</h3></div>
            <button className="table-download-button" type="button" onClick={downloadChannelPerformance}>↓ Download CSV</button>
          </div>
          <div className="category-performance-scroll">
            <table className="category-performance-table">
              <thead>
                <tr><th rowSpan={2}>Channel</th><th colSpan={4}>Current Period</th><th colSpan={4}>Comparison Period</th></tr>
                <tr><th>Plan</th><th>Actual</th><th>Var.</th><th>Var.%</th><th>Plan</th><th>Actual</th><th>Var.</th><th>Var.%</th></tr>
              </thead>
              <tbody>
                {channelPerformance.map((row) => {
                  const currentPlan = row.monthlyPlan * currentPlanMonths
                  const comparisonPlan = row.monthlyPlan * comparisonPlanMonths
                  const currentVariance = variance(row.currentActual, currentPlan)
                  const comparisonVariance = variance(row.comparisonActual, comparisonPlan)
                  const isTotal = row.channel === 'Total Sales' || row.channel === 'Grand Total Sales'
                  return <tr className={isTotal ? 'performance-total' : ''} key={row.channel}>
                    <th>{row.channel}</th>
                    <td>{number(currentPlan)}</td><td>{number(row.currentActual)}</td>
                    <td className={currentVariance >= 0 ? 'positive' : 'negative'}>{currentVariance >= 0 ? '+' : ''}{number(currentVariance)}</td>
                    <td className={currentVariance >= 0 ? 'positive' : 'negative'}>{variancePercent(row.currentActual, currentPlan).toFixed(1)}%</td>
                    <td>{number(comparisonPlan)}</td><td>{number(row.comparisonActual)}</td>
                    <td className={comparisonVariance >= 0 ? 'positive' : 'negative'}>{comparisonVariance >= 0 ? '+' : ''}{number(comparisonVariance)}</td>
                    <td className={comparisonVariance >= 0 ? 'positive' : 'negative'}>{variancePercent(row.comparisonActual, comparisonPlan).toFixed(1)}%</td>
                  </tr>
                })}
              </tbody>
            </table>
          </div>
        </section>
        <CategoryWiseSales rows={data.category_performance} loading={loading} />
        {selected !== 'all' && <ProductRankings data={data.product_performance} loading={loading} />}
        <TopProductByChannel channels={data.product_performance.channels} loading={loading} />
        <StateWisePerformance rows={data.state_performance} loading={loading} />
        <CustomersByEmail data={data.customer_performance} loading={loading} />
        </div>
      </>}
    </div>
  )
}

function CategoryReview({
  uploadId,
  initialRows,
  onBack,
  onContinue,
  channel,
}: {
  uploadId: string
  initialRows: ReviewRow[]
  onBack: () => void
  onContinue: () => void
  channel: UploadChannel
}) {
  const [rows, setRows] = useState(initialRows)
  const [choices, setChoices] = useState<Record<number, string>>({})
  const [splits, setSplits] = useState<Record<number, SplitPart[]>>({})
  const [busyRow, setBusyRow] = useState<number | null>(null)
  const [error, setError] = useState('')
  const standardRows = rows.filter((row) => !row.is_combo)
  const comboRows = rows.filter((row) => row.is_combo)

  const refresh = async () => {
    const response = await fetch(`/api/uploads/${channelPath(channel)}/${uploadId}/category-review`)
    const result = await response.json()
    if (!response.ok) throw new Error(result.detail ?? 'Unable to refresh category review.')
    setRows(result.records)
  }

  const updateCategory = async (row: ReviewRow) => {
    const category = choices[row.row_id]
    if (!category) {
      setError('Select a suggested category before updating the record.')
      return
    }
    setBusyRow(row.row_id)
    setError('')
    try {
      const response = await fetch(`/api/uploads/${channelPath(channel)}/${uploadId}/category-review/${row.row_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to update this category.')
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update this category.')
    } finally {
      setBusyRow(null)
    }
  }

  const splitCombo = async (row: ReviewRow) => {
    const parts = splits[row.row_id] ?? [
      { category: 'Books', amount: '' },
      { category: 'Web Version', amount: '' },
    ]
    if (parts.some((part) => !part.category || Number(part.amount) <= 0)) {
      setError('Select a category and enter a positive amount for every split row.')
      return
    }
    setBusyRow(row.row_id)
    setError('')
    try {
      const response = await fetch(`/api/uploads/${channelPath(channel)}/${uploadId}/category-review/${row.row_id}/split`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts: parts.map((part) => ({ ...part, amount: Number(part.amount) })) }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to split this Combo record.')
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to split this Combo record.')
    } finally {
      setBusyRow(null)
    }
  }

  const amount = (value: ReviewRow['amount']) => {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : String(value ?? '—')
  }

  return (
    <div className="content category-page">
      <button className="back-button" onClick={onBack}>← Back to upload</button>
      <section className="intro">
        <div>
          <span className="section-kicker">Data standardisation</span>
          <h2>Review {channel} categories</h2>
          <p>Known categories were mapped automatically. Resolve the records below before continuing.</p>
        </div>
        <div className="review-count"><strong>{rows.length}</strong><span>records remaining</span></div>
      </section>
      <section className="workflow">
        {['Upload', 'Category Review', 'Product Review', 'Save Dataset', 'Completed'].map((step, index) => (
          <div className={`workflow-step ${index === 1 ? 'current' : index === 0 ? 'done' : ''}`} key={step}>
            <span>{index === 0 ? '✓' : index + 1}</span><p>{step}</p>
          </div>
        ))}
      </section>

      {error && <div className="error-message review-error"><Icon name="info" size={18} /><span>{error}</span></div>}

      {rows.length === 0 ? (
        <section className="review-complete">
          <div className="complete-check">✓</div>
          <h2>Category review completed</h2>
          <p>Every {channel} record now uses one of the four standard categories.</p>
          <button className="primary-button" onClick={onContinue}>Continue <Icon name="chevron" size={17} /></button>
        </section>
      ) : (
        <>
          {standardRows.length > 0 && (
            <section className="review-panel">
              <div className="review-heading"><div><h3>Unknown categories</h3><p>Assign a standard category to each record.</p></div><span>{standardRows.length} remaining</span></div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Order number</th><th>Product name</th><th>Original category</th><th>Amount</th><th>Suggested category</th><th /></tr></thead>
                  <tbody>
                    {standardRows.map((row) => (
                      <tr key={row.row_id}>
                        <td>{row.order_number ?? '—'}</td><td className="product-cell">{row.product_name ?? '—'}</td>
                        <td><span className="category-tag">{row.original_category}</span></td><td>₹{amount(row.amount)}</td>
                        <td><select value={choices[row.row_id] ?? ''} onChange={(event) => setChoices({ ...choices, [row.row_id]: event.target.value })}>
                          <option value="">Select category</option><option>Books</option><option>Web Version</option><option>Audio Device</option><option>Pen Drive</option>
                        </select></td>
                        <td><button className="table-action" disabled={busyRow === row.row_id} onClick={() => updateCategory(row)}>{busyRow === row.row_id ? 'Updating…' : 'Update'}</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {comboRows.length > 0 && (
            <section className="review-panel combo-panel">
              <div className="review-heading"><div><h3>Combo category splitting</h3><p>Split each original amount across the appropriate standard categories.</p></div><span>{comboRows.length} remaining</span></div>
              {comboRows.map((row) => {
                const parts = splits[row.row_id] ?? [
                  { category: 'Books', amount: '' },
                  { category: 'Web Version', amount: '' },
                ]
                const total = parts.reduce((sum, part) => sum + Number(part.amount || 0), 0)
                const updatePart = (partIndex: number, change: Partial<SplitPart>) => {
                  const next = parts.map((part, index) => index === partIndex ? { ...part, ...change } : part)
                  setSplits({ ...splits, [row.row_id]: next })
                }
                return <div className="combo-card" key={row.row_id}>
                  <div className="combo-summary"><div><span>Order {row.order_number}</span><strong>{row.product_name}</strong></div><div><span>Original amount</span><strong>₹{amount(row.amount)}</strong></div></div>
                  <div className="combo-split-list">
                    {parts.map((part, partIndex) => <div className="combo-split-row" key={partIndex}>
                      <label><span>Category</span><select value={part.category} onChange={(event) => updatePart(partIndex, { category: event.target.value })}>
                        <option>Books</option><option>Web Version</option><option>Audio Device</option><option>Pen Drive</option>
                      </select></label>
                      <label><span>Split amount</span><div className="money-input">₹<input type="number" min="0" step="0.01" value={part.amount} onChange={(event) => updatePart(partIndex, { amount: event.target.value })} /></div></label>
                      {parts.length > 2 && <button className="remove-split" aria-label="Remove split row" onClick={() => setSplits({ ...splits, [row.row_id]: parts.filter((_, index) => index !== partIndex) })}><Icon name="x" size={16} /></button>}
                    </div>)}
                    <button className="add-split" onClick={() => setSplits({ ...splits, [row.row_id]: [...parts, { category: 'Audio Device', amount: '' }] })}>+ Add another category</button>
                  </div>
                  <div className="split-footer">
                    <div className={`split-total ${Math.abs(total - Number(row.amount)) < .01 ? 'matches' : ''}`}><span>Split total</span><strong>₹{amount(total)} / ₹{amount(row.amount)}</strong></div>
                    <button className="table-action" disabled={busyRow === row.row_id || Math.abs(total - Number(row.amount)) >= .01} onClick={() => splitCombo(row)}>{busyRow === row.row_id ? 'Updating…' : 'Update split'}</button>
                  </div>
                </div>
              })}
            </section>
          )}
        </>
      )}
    </div>
  )
}

function ProductReview({
  uploadId,
  initialGroups,
  onComplete,
  channel,
}: {
  uploadId: string
  initialGroups: ProductGroup[]
  onComplete: () => void
  channel: UploadChannel
}) {
  const [groups, setGroups] = useState(initialGroups)
  const [names, setNames] = useState<Record<string, Record<string, string>>>(
    Object.fromEntries(initialGroups.map((group) => [
      group.group_id,
      Object.fromEntries(group.variations.map((variation) => [variation, variation])),
    ])),
  )
  const [busyGroup, setBusyGroup] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [reviewCompleted, setReviewCompleted] = useState(false)

  const updateProduct = async (group: ProductGroup) => {
    const groupNames = names[group.group_id] ?? {}
    if (group.variations.some((variation) => !(groupNames[variation] ?? '').trim())) {
      setError('Enter a Standard Product Name for every detected variation.')
      return
    }
    setBusyGroup(group.group_id)
    setError('')
    setNotice('')
    try {
      const path = channelPath(channel)
      const response = await fetch(`/api/uploads/${path}/${uploadId}/product-review/${group.group_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mappings: group.variations.map((variation) => ({
            original_name: variation,
            standard_name: groupNames[variation].trim(),
          })),
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to update this product group.')
      const refresh = await fetch(`/api/uploads/${path}/${uploadId}/product-review`)
      const refreshed = await refresh.json()
      if (!refresh.ok) throw new Error(refreshed.detail ?? 'Unable to refresh Product Review.')
      if (refreshed.completed) {
        setGroups([])
        setReviewCompleted(true)
        setNotice(`Updated ${result.updated_records} record${result.updated_records === 1 ? '' : 's'} successfully.`)
        window.setTimeout(onComplete, 1800)
      } else {
        setGroups(refreshed.groups)
        setNotice(
          `Updated ${result.updated_records} record${result.updated_records === 1 ? '' : 's'} successfully. `
          + `${refreshed.remaining} similar product group${refreshed.remaining === 1 ? '' : 's'} still require review.`,
        )
        setNames(Object.fromEntries(refreshed.groups.map((item: ProductGroup) => [
          item.group_id,
          Object.fromEntries(item.variations.map((variation) => [variation, variation])),
        ])))
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update this product group.')
    } finally {
      setBusyGroup('')
    }
  }

  if (groups.length === 0 || reviewCompleted) {
    return (
      <div className="content category-page">
        <section className="review-complete">
          <div className="complete-check">✓</div>
          <h2>All Product Review Done</h2>
          <p>{notice || 'All detected product-name variations have been standardised.'}</p>
          <div className="auto-save-note"><span className="mini-spinner" /> Saving the reviewed dataset to PostgreSQL…</div>
        </section>
      </div>
    )
  }

  return (
    <div className="content category-page">
      <section className="intro">
        <div><span className="section-kicker">Product standardisation</span><h2>Review similar {channel === 'SFH' ? 'course' : 'product'} names</h2><p>Confirm one standard name for every detected group. All matching records will update immediately.</p></div>
        <div className="review-count"><strong>{groups.length}</strong><span>groups remaining</span></div>
      </section>
      <section className="workflow">
        {['Upload', 'Category Review', 'Product Review', 'Save Dataset', 'Completed'].map((step, index) => (
          <div className={`workflow-step ${index === 2 ? 'current' : index < 2 ? 'done' : ''}`} key={step}><span>{index < 2 ? '✓' : index + 1}</span><p>{step}</p></div>
        ))}
      </section>
      {error && <div className="error-message review-error"><Icon name="info" size={18} /><span>{error}</span></div>}
      {notice && <div className="success-message"><span className="success-icon">✓</span><span>{notice}</span></div>}
      <section className="product-groups">
        {groups.map((group) => (
          <article className="product-group" key={group.group_id}>
            <div className="product-group-head"><div><span>Similar product group</span><strong>{group.record_count} affected records</strong></div><span>{group.variations.length} variations</span></div>
            <div className="product-review-body">
              <div className="product-mapping-table">
                <div className="mapping-header"><span>Detected {channel === 'SFH' ? 'Course' : 'Product'} Variation</span><span>Standard Product Name</span></div>
                {group.variations.map((variation) => (
                  <div className="mapping-row" key={variation}>
                    <div className="variation-chip">{variation}</div>
                    <input
                      aria-label={`Standard name for ${variation}`}
                      value={names[group.group_id]?.[variation] ?? variation}
                      onChange={(event) => setNames({
                        ...names,
                        [group.group_id]: {
                          ...names[group.group_id],
                          [variation]: event.target.value,
                        },
                      })}
                    />
                  </div>
                ))}
              </div>
              <div className="product-update-action"><button className="table-action" disabled={busyGroup === group.group_id} onClick={() => updateProduct(group)}>{busyGroup === group.group_id ? 'Updating…' : 'Update'}</button></div>
            </div>
          </article>
        ))}
      </section>
    </div>
  )
}

function SavingDataset() {
  return (
    <div className="content category-page">
      <section className="review-complete">
        <div className="saving-spinner" /><h2>Saving DSG dataset</h2>
        <p>The reviewed dataset and Upload History record are being saved to PostgreSQL.</p>
      </section>
    </div>
  )
}

function UploadHistoryPage() {
  const [records, setRecords] = useState<HistoryRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState('')

  useEffect(() => {
    let active = true
    fetch('/api/uploads/history')
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail ?? 'Unable to load Upload History.')
        return result
      })
      .then((result) => {
        if (active) {
          setRecords(result.records)
          setError('')
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Unable to load Upload History.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => { active = false }
  }, [])

  const remove = async (record: HistoryRecord) => {
    if (!window.confirm(`Delete "${record.file_name}"?\n\nThis will also permanently delete all of its DSG rows from PostgreSQL.`)) return
    setDeleting(record.upload_id)
    try {
      const response = await fetch(`/api/uploads/history/${record.upload_id}`, { method: 'DELETE' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to delete this dataset.')
      setRecords((current) => current.filter((item) => item.upload_id !== record.upload_id))
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : 'Unable to delete this dataset.')
    } finally {
      setDeleting('')
    }
  }

  return (
    <div className="content category-page">
      <section className="intro"><div><span className="section-kicker">PostgreSQL records</span><h2>Upload History</h2><p>Every completed dataset has a unique ID. Deleting a record also deletes all of its stored channel rows.</p></div><div className="review-count"><strong>{records.length}</strong><span>datasets stored</span></div></section>
      {error && <div className="error-message history-error"><Icon name="info" size={18} /><span>{error}</span></div>}
      <section className="review-panel history-panel">
        {loading ? <div className="history-empty">Loading Upload History…</div> : records.length === 0 ? <div className="history-empty">No completed DSG datasets have been uploaded yet.</div> : (
          <div className="table-wrap"><table><thead><tr><th>Dataset ID</th><th>File name</th><th>Channel</th><th>Uploaded</th><th>Uploaded by</th><th>Records</th><th>Status</th><th /></tr></thead><tbody>
            {records.map((record) => <tr key={record.upload_id}>
              <td><span className="dataset-id" title={record.upload_id}>{record.upload_id.slice(0, 8)}…</span></td><td className="history-file">{record.file_name}</td><td><span className={`channel-badge ${record.channel.toLowerCase()}`}>{record.channel}</span></td>
              <td>{new Date(record.uploaded_at).toLocaleString()}</td><td>{record.uploaded_by}</td><td>{record.total_records.toLocaleString()}</td><td><span className="status-complete">{record.upload_status}</span></td>
              <td><button className="delete-button" disabled={deleting === record.upload_id} onClick={() => remove(record)}>{deleting === record.upload_id ? 'Deleting…' : 'Delete'}</button></td>
            </tr>)}
          </tbody></table></div>
        )}
      </section>
    </div>
  )
}

function App() {
  const [activeModule, setActiveModule] = useState<ModuleId>('upload')
  const [file, setFile] = useState<File | null>(null)
  const [inventoryFile, setInventoryFile] = useState<File | null>(null)
  const [directUnmatched, setDirectUnmatched] = useState<DirectUnmatched | null>(null)
  const [uploadState, setUploadState] = useState<UploadState>('idle')
  const [error, setError] = useState('')
  const [workflowPage, setWorkflowPage] = useState<WorkflowPage>('upload')
  const [uploadId, setUploadId] = useState('')
  const [reviewRows, setReviewRows] = useState<ReviewRow[]>([])
  const [productGroups, setProductGroups] = useState<ProductGroup[]>([])
  const [selectedChannel, setSelectedChannel] = useState<UploadChannel>('DSG')
  const fileInput = useRef<HTMLInputElement>(null)
  const inventoryFileInput = useRef<HTMLInputElement>(null)

  const selectFile = (candidate?: File, kind: 'invoice' | 'inventory' = 'invoice') => {
    if (!candidate) return
    const extension = candidate.name.split('.').pop()?.toLowerCase()
    if (!['csv', 'xlsx', 'xls'].includes(extension ?? '')) {
      setError('Please select a CSV or Excel file (.csv, .xlsx, .xls).')
      setUploadState('error')
      return
    }
    if (kind === 'inventory') setInventoryFile(candidate)
    else setFile(candidate)
    setError('')
    setUploadState('selected')
  }

  const upload = async () => {
    if (!file || (selectedChannel === 'Direct Sales' && !inventoryFile)) {
      setError('Direct Sales requires both the Invoice Dataset and Sales Inventory Dataset.')
      setUploadState('error')
      return
    }
    setUploadState('uploading')
    setError('')
    const body = new FormData()
    if (selectedChannel === 'Direct Sales') {
      body.append('invoice_file', file)
      body.append('inventory_file', inventoryFile as File)
    } else {
      body.append('file', file)
    }
    try {
      const path = channelPath(selectedChannel)
      const response = await fetch(`/api/uploads/${path}`, { method: 'POST', body })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'The file could not be validated.')
      sessionStorage.setItem('dsgUpload', JSON.stringify(result))
      setUploadId(result.upload_id)
      let uploadedUnmatched: DirectUnmatched | null = null
      if (selectedChannel === 'Direct Sales') {
        const unmatchedResponse = await fetch(`/api/uploads/direct-sales/${result.upload_id}/unmatched`)
        const unmatchedResult = await unmatchedResponse.json()
        if (!unmatchedResponse.ok) throw new Error(unmatchedResult.detail ?? 'Unable to load unmatched record details.')
        uploadedUnmatched = {
          invoice_records: unmatchedResult.invoice_records ?? [],
          inventory_records: unmatchedResult.inventory_records ?? [],
        }
        setDirectUnmatched(uploadedUnmatched)
      } else {
        setDirectUnmatched(null)
      }
      if (result.required_reviews.category) {
        const reviewResponse = await fetch(`/api/uploads/${path}/${result.upload_id}/category-review`)
        const reviewResult = await reviewResponse.json()
        if (!reviewResponse.ok) throw new Error(reviewResult.detail ?? 'Unable to open Category Review.')
        setReviewRows(reviewResult.records)
        setWorkflowPage('category')
      } else if (result.required_reviews.product) {
        const productResponse = await fetch(`/api/uploads/${path}/${result.upload_id}/product-review`)
        const productResult = await productResponse.json()
        if (!productResponse.ok) throw new Error(productResult.detail ?? 'Unable to open Product Review.')
        setProductGroups(productResult.groups)
        setWorkflowPage('product')
      } else {
        await completeAndShowHistory(result.upload_id, uploadedUnmatched)
      }
      setUploadState('selected')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Unable to connect to the upload service.'
      setError(message)
      window.alert(message)
      setUploadState('error')
    }
  }

  const activeLabel = modules.find((item) => item.id === activeModule)?.label ?? ''

  const completeAndShowHistory = async (id = uploadId, unmatchedOverride: DirectUnmatched | null = null) => {
    setWorkflowPage('saving')
    try {
      const response = await fetch(`/api/uploads/${channelPath(selectedChannel)}/${id}/complete`, { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to save the DSG dataset.')
      const valueFrom = (record: Record<string, unknown>, names: string[]) => {
        const entry = Object.entries(record).find(([key]) => names.includes(key.trim().toLowerCase()))
        return entry?.[1] == null ? '' : String(entry[1])
      }
      const unmatched = unmatchedOverride ?? directUnmatched
      const unmatchedDetails = selectedChannel === 'Direct Sales' && unmatched
        ? [
            unmatched.invoice_records.length
              ? `Unmatched Invoice Numbers: ${unmatched.invoice_records.map((record) => valueFrom(record, ['invoice number'])).filter(Boolean).join(', ')}`
              : '',
            unmatched.inventory_records.length
              ? `Unmatched Inventory Doc Nos.: ${unmatched.inventory_records.map((record) => valueFrom(record, ['doc no.', 'doc no'])).filter(Boolean).join(', ')}`
              : '',
          ].filter(Boolean).join('\n')
        : ''
      const summary = selectedChannel === 'Direct Sales'
        ? `\nProcessed: ${result.processed}\nMatched: ${result.matched}\nUnmatched: ${result.unmatched}${unmatchedDetails ? `\n\n${unmatchedDetails}` : ''}`
        : ''
      window.alert(`${selectedChannel} dataset saved successfully.\nDataset ID: ${result.upload_id}${summary}`)
      setFile(null)
      setInventoryFile(null)
      setDirectUnmatched(null)
      setUploadState('idle')
      setActiveModule('history')
      setWorkflowPage('upload')
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Unable to save the DSG dataset.'
      setError(message)
      setWorkflowPage('upload')
      window.alert(message)
    }
  }

  const continueAfterCategory = async () => {
    setError('')
    try {
      const response = await fetch(`/api/uploads/${channelPath(selectedChannel)}/${uploadId}/product-review`)
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to determine the next review step.')
      if (result.completed) {
        await completeAndShowHistory()
      } else {
        setProductGroups(result.groups)
        setWorkflowPage('product')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to continue.')
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div><strong>Meru MIS</strong><span>Sales intelligence</span></div>
        </div>
        <nav aria-label="Main navigation">
          <p className="nav-label">Workspace</p>
          {modules.map((item) => (
            <button className={`nav-item ${activeModule === item.id ? 'active' : ''}`} key={item.id} onClick={() => setActiveModule(item.id)}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.id === 'upload' && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div className="user-avatar">AK</div>
          <div className="user-copy"><strong>Admin User</strong><span>admin@meru.com</span></div>
          <button className="icon-button" aria-label="Log out"><Icon name="logout" size={18} /></button>
        </div>
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">MIS Sales / {activeLabel}</p>
            <h1>{activeLabel}</h1>
          </div>
          <div className="environment"><span /> Production</div>
        </header>

        {activeModule === 'dashboard' ? <DashboardPage /> : activeModule === 'reports' ? <ReportCenter /> : activeModule === 'history' ? <UploadHistoryPage /> : activeModule !== 'upload' ? <Placeholder title={activeLabel} /> : workflowPage === 'category' ? (
          <CategoryReview uploadId={uploadId} initialRows={reviewRows} channel={selectedChannel} onBack={() => setWorkflowPage('upload')} onContinue={continueAfterCategory} />
        ) : workflowPage === 'product' ? (
          <ProductReview uploadId={uploadId} initialGroups={productGroups} channel={selectedChannel} onComplete={() => { void completeAndShowHistory() }} />
        ) : workflowPage === 'saving' ? (
          <SavingDataset />
        ) : (
          <div className="content">
            <section className="intro">
              <div>
                <span className="section-kicker">Data ingestion</span>
                <h2>Bring your sales data into MIS</h2>
                <p>Select a channel and upload its latest dataset. Each channel runs in its own independent workflow.</p>
              </div>
              <div className="step-count"><strong>01</strong><span>of 05 steps</span></div>
            </section>

            <section className="channel-grid" aria-label="Sales channels">
              {channels.map((channel) => (
                <article
                  className={`channel-card ${channel.name === selectedChannel ? 'selected' : !['DSG', 'SFH', 'Direct Sales'].includes(channel.name) ? 'disabled' : 'available'}`}
                  key={channel.name}
                  onClick={() => {
                    if (channel.name === 'DSG' || channel.name === 'SFH' || channel.name === 'Direct Sales') {
                      setSelectedChannel(channel.name)
                      setFile(null)
                      setInventoryFile(null)
                      setDirectUnmatched(null)
                      setError('')
                      setUploadState('idle')
                    }
                  }}
                >
                  <div className={`channel-icon ${channel.tone}`}>{channel.name.slice(0, 2).toUpperCase()}</div>
                  <div><h3>{channel.name}</h3><span>{channel.status}</span></div>
                  {channel.name === selectedChannel && <div className="selected-check">✓</div>}
                </article>
              ))}
            </section>

            <section className="workflow">
              {['Upload', 'Category Review', 'Product Review', 'Save Dataset', 'Completed'].map((step, index) => (
                <div className={`workflow-step ${index === 0 ? 'current' : ''}`} key={step}>
                  <span>{index + 1}</span><p>{step}</p>
                </div>
              ))}
            </section>

            <section className="upload-panel">
              <div className="panel-header">
                <div><span className="panel-number">01</span><div><h2>Upload {selectedChannel} dataset{selectedChannel === 'Direct Sales' ? 's' : ''}</h2><p>{selectedChannel === 'Direct Sales' ? 'Upload both mandatory files before validation and mapping.' : 'Upload one complete file for validation and processing.'}</p></div></div>
                <span className="format-pill">CSV · XLSX · XLS</span>
              </div>

              {!file ? (
                <div className={`drop-zone ${uploadState === 'error' ? 'has-error' : ''}`}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => { event.preventDefault(); selectFile(event.dataTransfer.files[0]) }}
                  onClick={() => fileInput.current?.click()}>
                  <div className="upload-orbit"><Icon name="cloud" size={30} /></div>
                  <h3>Drop your {selectedChannel === 'Direct Sales' ? 'Invoice Dataset' : `${selectedChannel} dataset`} here</h3>
                  <p>or <button type="button">browse from your computer</button></p>
                  <span>Maximum file size: 50 MB</span>
                  <input ref={fileInput} type="file" accept=".csv,.xlsx,.xls" onChange={(event) => selectFile(event.target.files?.[0])} hidden />
                </div>
              ) : (
                <div className="file-selected">
                  <div className="file-icon"><Icon name="file" size={24} /></div>
                  <div className="file-meta"><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(2)} MB · Ready to validate</span></div>
                  <button className="remove-file" aria-label="Remove file" onClick={() => { setFile(null); setUploadState('idle'); setError('') }}><Icon name="x" size={18} /></button>
                </div>
              )}

              {selectedChannel === 'Direct Sales' && (!inventoryFile ? (
                <div className={`drop-zone secondary-drop ${uploadState === 'error' ? 'has-error' : ''}`}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => { event.preventDefault(); selectFile(event.dataTransfer.files[0], 'inventory') }}
                  onClick={() => inventoryFileInput.current?.click()}>
                  <div className="upload-orbit"><Icon name="cloud" size={30} /></div>
                  <h3>Drop your Sales Inventory Dataset here</h3>
                  <p>or <button type="button">browse from your computer</button></p>
                  <span>Required columns: Doc No., Category, Item Details, Qty</span>
                  <input ref={inventoryFileInput} type="file" accept=".csv,.xlsx,.xls" onChange={(event) => selectFile(event.target.files?.[0], 'inventory')} hidden />
                </div>
              ) : (
                <div className="file-selected secondary-drop">
                  <div className="file-icon"><Icon name="file" size={24} /></div>
                  <div className="file-meta"><strong>{inventoryFile.name}</strong><span>{(inventoryFile.size / 1024 / 1024).toFixed(2)} MB · Sales Inventory Dataset</span></div>
                  <button className="remove-file" aria-label="Remove inventory file" onClick={() => { setInventoryFile(null); setUploadState('idle'); setError('') }}><Icon name="x" size={18} /></button>
                </div>
              ))}

              {error && <div className="error-message"><Icon name="info" size={18} /><span>{error}</span></div>}

              <div className="requirements">
                <Icon name="info" size={18} />
                <div><strong>Before you upload</strong><p>{selectedChannel === 'DSG' ? 'Your file must include Order Number, Product Name, Category, and Item Cost × Quantity.' : selectedChannel === 'SFH' ? 'Your SFH file must include Course, Currency, Without Tax Total, and Earnings. Category will be set automatically to Web Version.' : 'Invoice requires Invoice Number, Without Tax Total, and Private Notes. Sales Inventory requires Doc No., Category, Item Details, and Qty. Only matching identifiers will be processed; unmatched records are logged.'} Existing columns and calculations will be preserved.</p></div>
              </div>
              <div className="panel-actions">
                <p><span className="secure-dot" /> Your data is processed securely</p>
                <button className="primary-button" disabled={!file || (selectedChannel === 'Direct Sales' && !inventoryFile) || uploadState === 'uploading'} onClick={upload}>
                  {uploadState === 'uploading' ? 'Validating…' : 'Validate & continue'} <Icon name="chevron" size={17} />
                </button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
