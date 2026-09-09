import { Fragment, useEffect, useRef, useState } from 'react'
import './App.css'

type ModuleId = 'dashboard' | 'upload' | 'reports' | 'plans' | 'history'
type UploadState = 'idle' | 'selected' | 'uploading' | 'error'
type WorkflowPage = 'upload' | 'category' | 'product' | 'saving'
type UploadChannel = 'DSG' | 'SFH' | 'Amazon' | 'Direct Sales'
type DashboardView = 'overview' | 'product' | 'state' | 'customer' | 'financial'
type DashboardPageFilter = { channel: string | null; dateFilterMode: 'date' | 'month' | 'range'; dateStart: string; dateEnd: string }

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
  selected_year: number
  available_years: number[]
  monthly_plans?: Record<string, number>
  comparison_monthly_plans?: Record<string, number>
  category_monthly_plans?: Record<string, number>
  comparison_category_monthly_plans?: Record<string, number>
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
    details: {
      year: number; month: number; channel: string; category: string; orders: number; quantity: number
      description: string; basic_value: number; shipping: number; discount: number
      taxable_value: number; tax: number; total_invoice_value: number
    }[]
  }
  customer_performance: {
    total_customers: number
    unique_customers: number
    repeat_customers: number
    unique_percent: number
    repeat_percent: number
    trend: { key: string; label: string; new_percent: number; returning_percent: number }[]
    aov: { new: number; returning: number }
    repeat_rate_delta: number
    repeat_rate_declining: boolean
  }
  financial_breakdown: Record<string, {
    basic_value: number; shipping: number; discount: number
    taxable_value: number; total_tax: number; total_sale: number
  }>
  state_performance: { state: string; amount: number; orders: number; customers: number }[]
  state_order_details: {
    year: number; month: number; channel: string; order_id: string; category: string
    description: string; quantity: number; sales: number; state: string; email?: string; customer_name?: string
    classification: 'india' | 'international' | 'invalid'
  }[]
  direct_sales_performance: {
    current: Record<string, number>
    comparison: Record<string, number>
  }
  channel_wise_performance: {
    current: Record<string, number>
    comparison: Record<string, number>
  }
  sales_trend: {
    monthly_points: {
      key: string
      label: string
      value: number
      breakdown: Record<string, number>
    }[]
  }
  filters: { id: string; label: string }[]
  cards: KpiCardData[]
}

type TimeSelection = {
  grain: 'monthly' | 'quarterly' | 'yearly'
  period: string
}

type DashboardFilters = {
  channel: string
  time: TimeSelection
  year: number
  comparison: TimeSelection
  comparisonYear: number
}

const DASHBOARD_FILTERS_KEY = 'mis-sales-dashboard-filters'
const DASHBOARD_CACHE_TTL_MS = 5 * 60 * 1000
const DASHBOARD_CHANNEL_OPTIONS = [
  { value: 'all', label: 'All Channels' },
  { value: 'dsg', label: 'DSG' },
  { value: 'sfh', label: 'SFH' },
  { value: 'direct', label: 'Direct Sales' },
  { value: 'amazon', label: 'Amazon' },
] as const
const DASHBOARD_RECORD_CHANNEL_OPTIONS = [
  { value: 'all', label: 'All Channels' },
  { value: 'DSG', label: 'DSG' },
  { value: 'SFH', label: 'SFH' },
  { value: 'Direct Sales', label: 'Direct Sales' },
  { value: 'Amazon', label: 'Amazon' },
] as const
const dashboardResponseCache = new Map<string, { data: DashboardData; storedAt: number }>()

function clearDashboardCache() {
  dashboardResponseCache.clear()
}

function savedDashboardFilters(fallback: DashboardFilters): DashboardFilters {
  try {
    const saved = JSON.parse(localStorage.getItem(DASHBOARD_FILTERS_KEY) ?? '') as Partial<DashboardFilters>
    const grains = new Set(['monthly', 'quarterly', 'yearly'])
    if (
      typeof saved.channel === 'string'
      && saved.time && grains.has(saved.time.grain) && typeof saved.time.period === 'string'
      && Number.isInteger(saved.year)
      && saved.comparison && grains.has(saved.comparison.grain) && typeof saved.comparison.period === 'string'
      && Number.isInteger(saved.comparisonYear)
    ) return saved as DashboardFilters
  } catch { /* Use current-period defaults when no valid saved filters exist. */ }
  return fallback
}

function shouldUseLatestDashboardPeriod(currentYear: number, currentMonth: string) {
  const stored = localStorage.getItem(DASHBOARD_FILTERS_KEY)
  if (stored === null) return true
  try {
    const saved = JSON.parse(stored) as Partial<DashboardFilters>
    return saved.time?.grain === 'monthly'
      && saved.time.period === currentMonth
      && saved.year === currentYear
  } catch {
    return true
  }
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

const DEFAULT_2026_SALES_PLANS: Record<string, number> = {
  DSG: 100000,
  SFH: 100000,
  Amazon: 100000,
  'Direct Sales': 200000,
}

const CHANNEL_MONTHLY_PLANS = {
  digitalOnline: 300000,
  inOffice: 50000,
  stall: 50000,
  bulk: 25000,
  call: 25000,
  retail: 25000,
  coursePromotion: 25000,
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
  { id: 'plans', label: 'Plan Updation', icon: 'calendar' },
  { id: 'history', label: 'Upload history', icon: 'history' },
]

const channels = [
  { name: 'DSG', status: 'Available', tone: 'indigo' },
  { name: 'SFH', status: 'Available', tone: 'violet' },
  { name: 'Amazon', status: 'Available', tone: 'orange' },
  { name: 'Direct Sales', status: 'Available', tone: 'teal' },
]

const channelPath = (channel: UploadChannel) => channel === 'Direct Sales' ? 'direct-sales' : channel.toLowerCase()
const channelDisplayName = (channel: string) => channel === 'DSG'
  ? 'DSG'
  : channel === 'SFH'
    ? 'SFH'
    : channel

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

const reportPercentage = (value: number) => `${Math.round(value)}%`

function reconciledWholeValues(values: number[], target: number): number[] {
  const displayed = values.map((value) => Math.round(value))
  const difference = Math.round(target) - displayed.reduce((sum, value) => sum + value, 0)
  if (!difference || !values.length) return displayed
  const errors = values.map((value, index) => value - displayed[index])
  const direction = difference > 0 ? 1 : -1
  const order = values.map((_, index) => index).sort((left, right) =>
    difference > 0 ? errors[right] - errors[left] : errors[left] - errors[right],
  )
  for (let offset = 0; offset < Math.abs(difference); offset += 1) {
    displayed[order[offset % order.length]] += direction
  }
  return displayed
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
    calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4m8-4v4M3 10h18" /><path d="M8 14h.01m4 0h.01m4 0h.01M8 18h.01m4 0h.01" /></>,
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

type ReportType = 'summary' | 'channel' | 'category' | 'product' | 'direct-sales-overview'

function DirectOverviewFilter({ label, options, selected, onChange }: { label: string; options: { value: string; label: string }[]; selected: string[]; onChange: (values: string[]) => void }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const selectedSet = new Set(selected)
  const summary = selected.length === 1 && label === 'Year'
    ? options.find((option) => option.value === selected[0])?.label ?? selected[0]
    : `${selected.length} selected`

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const icon = label === 'Year' || label === 'Month'
    ? <Icon name="calendar" size={15} />
    : label === 'Type'
      ? <Icon name="grid" size={15} />
      : <span className="direct-filter-cube" aria-hidden="true">◇</span>

  return <div className={`direct-filter ${open ? 'open' : ''}`} ref={rootRef}>
    <span className="direct-filter-label">{label}</span>
    <button type="button" className="direct-filter-trigger" onClick={() => setOpen((current) => !current)} aria-haspopup="listbox" aria-expanded={open}>
      <span className="direct-filter-summary">{icon}<strong>{summary}</strong></span><span className="direct-filter-chevron" aria-hidden="true" />
    </button>
    {open && <div className="direct-filter-menu">
      <div className="direct-filter-actions"><button type="button" onClick={() => onChange(options.map((option) => option.value))}>Select all</button><button type="button" onClick={() => onChange([])}>Clear</button></div>
      <div className="direct-filter-options" role="listbox" aria-multiselectable="true">{options.map((option) => <label key={option.value}><input type="checkbox" checked={selectedSet.has(option.value)} onChange={() => onChange(selectedSet.has(option.value) ? selected.filter((value) => value !== option.value) : [...selected, option.value])} /><span>{option.label}</span></label>)}</div>
    </div>}
  </div>
}

function ReportCenter() {
  const today = new Date()
  const [grain, setGrain] = useState<'monthly' | 'yearly'>('monthly')
  const [month, setMonth] = useState(String(today.getMonth() + 1))
  const [year, setYear] = useState(today.getFullYear())
  const [reportType, setReportType] = useState<ReportType>('summary')
  const [directOptions, setDirectOptions] = useState<{ years: number[]; months: number[]; types: string[]; products: string[] } | null>(null)
  const [directYears, setDirectYears] = useState<string[]>([])
  const [directMonths, setDirectMonths] = useState<string[]>([])
  const [directTypes, setDirectTypes] = useState<string[]>([])
  const [directProducts, setDirectProducts] = useState<string[]>([])
  const [directPreview, setDirectPreview] = useState<{ row_count: number; source_records: number; totals: Record<string, number>; overall_total: number; validated: boolean } | null>(null)
  const [directError, setDirectError] = useState('')
  const [directLoading, setDirectLoading] = useState(false)
  const reportNames: Record<ReportType, string> = {
    summary: 'Summary Report', channel: 'Channel Wise Performance Report',
    category: 'Category Wise Performance Report', product: 'Product Wise Performance Report',
    'direct-sales-overview': 'Direct Sales Overview',
  }
  const isDirectOverview = reportType === 'direct-sales-overview'
  const selectedMonths = month.split(',').filter(Boolean).map(Number).sort((a, b) => a - b)
  const periodLabel = grain === 'monthly'
    ? `${selectedMonths.map((value) => months[value - 1].slice(0, 3)).join(', ')} - ${String(year).slice(-2)}`
    : String(year)
  const download = (dataset: 'report' | 'clean') => {
    const params = new URLSearchParams({ grain, period: grain === 'monthly' ? month : String(year), year: String(year), report_type: reportType, dataset })
    window.location.assign(`/api/reports/download?${params}`)
  }
  const directParams = () => {
    const params = new URLSearchParams()
    directYears.forEach((value) => params.append('years', value))
    directMonths.forEach((value) => params.append('months', value))
    directTypes.forEach((value) => params.append('types', value))
    if (directProducts.length !== directOptions?.products.length) {
      directProducts.forEach((value) => params.append('products', value))
    }
    return params
  }
  useEffect(() => {
    fetch('/api/reports/direct-sales-overview/options')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Unable to load Direct Sales report filters.')))
      .then((options) => {
        setDirectOptions(options)
        setDirectYears(options.years.length ? [String(options.years[0])] : [])
        setDirectMonths(months.map((_, index) => String(index + 1)))
        setDirectTypes(options.types)
        setDirectProducts(options.products)
      })
      .catch((reason) => setDirectError(reason instanceof Error ? reason.message : 'Unable to load Direct Sales report filters.'))
  }, [])
  useEffect(() => {
    if (!isDirectOverview || !directYears.length || !directMonths.length || !directTypes.length || !directProducts.length) {
      setDirectPreview(null)
      return
    }
    const controller = new AbortController()
    setDirectLoading(true)
    setDirectError('')
    fetch(`/api/reports/direct-sales-overview/preview?${directParams()}`, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail ?? 'Direct Sales report validation failed.')
        setDirectPreview(result)
      })
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setDirectPreview(null)
        setDirectError(reason instanceof Error ? reason.message : 'Direct Sales report validation failed.')
      })
      .finally(() => setDirectLoading(false))
    return () => controller.abort()
  }, [isDirectOverview, directYears, directMonths, directTypes, directProducts])
  const downloadDirectOverview = async () => {
    if (!directPreview?.validated) return
    setDirectLoading(true)
    setDirectError('')
    try {
      const response = await fetch(`/api/reports/direct-sales-overview/download?${directParams()}`)
      if (!response.ok) {
        const result = await response.json()
        throw new Error(result.detail ?? 'Direct Sales Overview could not be downloaded.')
      }
      const url = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = url
      link.download = 'direct-sales-overview.xlsx'
      link.click()
      URL.revokeObjectURL(url)
    } catch (reason) {
      setDirectError(reason instanceof Error ? reason.message : 'Direct Sales Overview could not be downloaded.')
    } finally {
      setDirectLoading(false)
    }
  }

  return <div className={`content report-center${isDirectOverview ? ' direct-sales-overview-theme' : ''}`}>
    <section className="intro"><div><span className="section-kicker">Reporting & exports</span><h2>Sales Report Center</h2><p>Build monthly or yearly MIS reports and download filtered source data or a presentation-ready Excel workbook.</p></div></section>
    <section className="report-filter-card">
      <div className="report-filter-grid">
        {!isDirectOverview && <><label><span>Period type</span><select value={grain} onChange={(event) => setGrain(event.target.value as 'monthly' | 'yearly')}><option value="monthly">Monthly</option><option value="yearly">Yearly</option></select></label>
        {grain === 'monthly' && <label><span>Month (single or multiple)</span><MonthChecklistDropdown value={month} onChange={setMonth} /></label>}
        <label><span>Year</span><select value={year} onChange={(event) => setYear(Number(event.target.value))}>{Array.from({ length: 6 }, (_, index) => today.getFullYear() - index).map((value) => <option key={value}>{value}</option>)}</select></label></>}
        <label className="report-type-field"><span>Report</span><select value={reportType} onChange={(event) => setReportType(event.target.value as ReportType)}>{Object.entries(reportNames).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      </div>
      {isDirectOverview && directOptions && <div className="direct-overview-filters">
        <DirectOverviewFilter label="Year" options={directOptions.years.map((value) => ({ value: String(value), label: String(value) }))} selected={directYears} onChange={setDirectYears} />
        <DirectOverviewFilter label="Month" options={months.map((label, index) => ({ value: String(index + 1), label }))} selected={directMonths} onChange={setDirectMonths} />
        <DirectOverviewFilter label="Type" options={directOptions.types.map((value) => ({ value, label: value }))} selected={directTypes} onChange={setDirectTypes} />
        <DirectOverviewFilter label="Product" options={directOptions.products.map((value) => ({ value, label: value }))} selected={directProducts} onChange={setDirectProducts} />
      </div>}
    </section>
    {isDirectOverview && <section className="report-preview-card report-export-card direct-overview-card">
      <div className="report-preview-head"><div><span className="section-kicker">Styled Excel export</span><h3>Direct Sales Overview</h3><p>Provides the detailed In Office, Stall, Bulk, Call, Retail, Course Promotion, and Language Lab classification.</p></div><span className="format-pill">XLSX</span></div>
      {directError && <div className="error-message">{directError}</div>}
      {directPreview?.validated && <div className="direct-overview-validation">
        {directOptions?.types.map((type) => <div key={type}><span>{type}</span><strong>{Math.round(directPreview.totals[type] ?? 0).toLocaleString('en-IN')}</strong></div>)}
        <div className="overall"><span>Overall Total</span><strong>{Math.round(directPreview.overall_total).toLocaleString('en-IN')}</strong></div>
      </div>}
      <div className="report-download-footer"><div><strong>{directPreview?.validated ? 'Reconciled and ready' : directLoading ? 'Validating report…' : 'Select filters to validate'}</strong><span>{directPreview ? `${directPreview.row_count.toLocaleString('en-IN')} unique rows from ${directPreview.source_records.toLocaleString('en-IN')} records.` : 'Download is enabled only after dashboard reconciliation succeeds.'}</span></div><button className="primary-download" disabled={!directPreview?.validated || directLoading} onClick={() => { void downloadDirectOverview() }}>↓ Download Excel</button></div>
    </section>}
    {!isDirectOverview && <section className="report-preview-card report-export-card">
      <div className="report-preview-head"><div><span className="section-kicker">Excel export</span><h3>{reportNames[reportType]}</h3><p>{periodLabel} · The requested report formatting will be applied inside the downloaded Excel file.</p></div><span className="format-pill">XLSX</span></div>
      <div className="report-download-footer"><div><strong>Ready to export</strong><span>Download the selected report or its standardized cleaned dataset.</span></div><div><button className="secondary-download" onClick={() => download('report')}>↓ Download Report</button><button className="primary-download" onClick={() => download('clean')}>↓ Download Cleaned Dataset</button></div></div>
    </section>}
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
    label: `${change > 0 ? '+' : ''}${Math.round(change)}%`,
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

type SalesPlanTooltipProps = {
  period: string
  planValue: number
  salesValue: number
  locale?: string
}

export function SalesPlanTooltip({ period, planValue, salesValue, locale = 'en-IN' }: SalesPlanTooltipProps) {
  const formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 })
  const gap = salesValue - planValue
  const isOverPlan = gap >= 0
  const achieved = planValue > 0 ? Math.round((salesValue / planValue) * 100) : 0
  const progress = planValue > 0 ? Math.min(Math.max((salesValue / planValue) * 100, 0), 100) : 0
  const tickPosition = Math.min(Math.max(progress, .5), 99.5)
  const status = isOverPlan ? 'over' : 'under'

  return <div className={`sales-plan-tooltip ${status}`} role="status">
    <div className="sales-plan-tooltip-head">
      <strong>{period}</strong>
      <span className="sales-plan-achievement">{achieved}% achieved</span>
    </div>
    <div className="sales-plan-values">
      <div><span className="sales-plan-label"><i className="plan" />Plan</span><strong>{formatter.format(planValue)}</strong></div>
      <div><span className="sales-plan-label"><i className="sales" />Sales</span><strong>{formatter.format(salesValue)}</strong></div>
    </div>
    <div className="sales-plan-progress" aria-label={`${achieved}% of plan achieved`}>
      <div className="sales-plan-track"><span style={{ width: `${progress}%` }} /><i style={{ left: `${tickPosition}%` }} /></div>
      <div className="sales-plan-axis"><span>0</span><span>{formatter.format(planValue)}</span></div>
    </div>
    <div className="sales-plan-verdict">
      <span className="sales-plan-direction" aria-hidden="true">{isOverPlan ? '▲' : '▼'}</span>
      <span>Sales are <strong>{formatter.format(Math.abs(gap))} {isOverPlan ? 'above plan' : 'below plan'}</strong></span>
    </div>
  </div>
}

function SalesTrendChart({ trend, loading, monthlyPlans, allMonthlyPlan, initialChannel = 'all' }: { trend: DashboardData['sales_trend']; loading: boolean; monthlyPlans: Record<string, number>; allMonthlyPlan?: number; initialChannel?: string }) {
  const [grouping, setGrouping] = useState<'month' | 'quarter' | 'year'>('month')
  const [trendChannel, setTrendChannel] = useState(initialChannel)
  const [activePoint, setActivePoint] = useState<number | null>(null)
  const selectedMonthlyPlan = trendChannel === 'all'
    ? (allMonthlyPlan ?? Object.values(monthlyPlans).reduce((sum, plan) => sum + plan, 0))
    : (monthlyPlans[trendChannel] ?? 0)
  const grouped = (() => {
    const values = new Map<string, { label: string; value: number; plan: number; breakdown: Record<string, number> }>()
    trend.monthly_points.forEach((point) => {
      const [year, month] = point.key.split('-').map(Number)
      const quarter = Math.floor((month - 1) / 3) + 1
      const key = grouping === 'month' ? point.key : grouping === 'quarter' ? `${year}-Q${quarter}` : String(year)
      const label = grouping === 'month' ? point.label : grouping === 'quarter' ? `Q${quarter} ${year}` : String(year)
      const aggregate = values.get(key) ?? { label, value: 0, plan: 0, breakdown: {} }
      aggregate.value += trendChannel === 'all' ? point.value : (point.breakdown[trendChannel] ?? 0)
      aggregate.plan += selectedMonthlyPlan
      Object.entries(point.breakdown).forEach(([channel, value]) => {
        aggregate.breakdown[channel] = (aggregate.breakdown[channel] ?? 0) + value
      })
      values.set(key, aggregate)
    })
    return [...values.values()].filter((point) => point.value !== 0)
  })()
  const width = 860
  const height = 360
  const padding = { top: 52, right: 34, bottom: 48, left: 72 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  const pointInset = 34
  const pointWidth = chartWidth - pointInset * 2
  const maximum = Math.max(...grouped.map((point) => point.value), 1)
  const magnitude = 10 ** Math.floor(Math.log10(maximum))
  const step = Math.max(magnitude, Math.ceil(maximum / (4 * magnitude)) * magnitude)
  const axisMaximum = Math.ceil(maximum / step) * step
  const tickCount = 10
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => (axisMaximum / tickCount) * index)
  const points = grouped.map((point, index) => ({
    ...point,
    x: padding.left + (grouped.length === 1
      ? chartWidth / 2
      : pointInset + (index / (grouped.length - 1)) * pointWidth),
    y: padding.top + chartHeight - (point.value / axisMaximum) * chartHeight,
  }))
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' ')
  const areaPath = points.length ? `${path} L ${points[points.length - 1].x} ${padding.top + chartHeight} L ${points[0].x} ${padding.top + chartHeight} Z` : ''
  const number = (value: number) => Math.round(value).toLocaleString('en-IN')
  const active = activePoint === null ? null : points[activePoint]
  const tooltipWidth = 238
  const tooltipHeight = 194
  const tooltipX = active ? Math.min(Math.max(active.x - tooltipWidth / 2, padding.left), width - padding.right - tooltipWidth) : 0
  const tooltipY = active ? Math.max(active.y - tooltipHeight - 16, 8) : 0
  return <section className={`sales-trend-card ${loading ? 'is-loading' : ''}`}>
    <div className="sales-trend-head"><div><span className="section-kicker">Sales movement</span><h3>Sales Trend</h3></div><div className="sales-trend-controls"><label className="sales-trend-channel"><span>Channel</span><select value={trendChannel} onChange={(event) => { setTrendChannel(event.target.value); setActivePoint(null) }}>{DASHBOARD_RECORD_CHANNEL_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><div className="sales-trend-segments" role="group" aria-label="Group sales trend">{(['month', 'quarter', 'year'] as const).map((mode) => <button type="button" className={grouping === mode ? 'active' : ''} key={mode} onClick={() => { setGrouping(mode); setActivePoint(null) }}>By {mode}</button>)}</div></div></div>
    {points.length ? <div className="sales-trend-scroll"><svg className="sales-trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Sales trend grouped by ${grouping}: ${grouped.map((point) => `${point.label} ${number(point.value)}`).join(', ')}`} onMouseLeave={() => setActivePoint(null)}>
      {ticks.map((tick) => {
        const y = padding.top + chartHeight - (tick / axisMaximum) * chartHeight
        return <g key={tick}><line className="sales-grid-line" x1={padding.left} x2={width - padding.right} y1={y} y2={y} /><text className="sales-y-label" x={padding.left - 12} y={y + 4}>{number(tick)}</text></g>
      })}
      <path className="sales-trend-area" d={areaPath} />
      <path className="sales-trend-line" d={path} />
      {points.map((point, index) => <g className="sales-trend-target" key={point.label} tabIndex={0} role="button" aria-label={`${point.label}. Sales ${number(point.value)}. Plan ${number(point.plan)}`} onMouseEnter={() => setActivePoint(index)} onFocus={() => setActivePoint(index)} onBlur={() => setActivePoint(null)}>
        <circle className="sales-trend-hit-area" cx={point.x} cy={point.y} r="16" />
        <circle className={`sales-trend-point ${activePoint === index ? 'is-active' : ''}`} cx={point.x} cy={point.y} r="5" />
        <text className="sales-value-label" x={point.x} y={Math.max(point.y - 23, 16)} textAnchor="middle">{number(point.value)}</text>
        {index > 0 && points[index - 1].value !== 0 && <text className={point.value >= points[index - 1].value ? 'sales-change-label positive' : 'sales-change-label negative'} x={point.x} y={Math.max(point.y - 11, 28)} textAnchor="middle">{`${point.value >= points[index - 1].value ? '+' : ''}${Math.round(((point.value - points[index - 1].value) / Math.abs(points[index - 1].value)) * 100)}%`}</text>}
        <text className="sales-x-label" x={point.x} y={height - padding.bottom + 25} textAnchor="middle">{point.label}</text>
      </g>)}
      {active && <foreignObject className="sales-plan-tooltip-object" x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} pointerEvents="none">
        <SalesPlanTooltip period={active.label} planValue={active.plan} salesValue={active.value} />
      </foreignObject>}
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
  channel,
  onChannelChange,
  dateFilter,
}: {
  rows: DashboardData['category_performance']
  loading: boolean
  channel: string
  onChannelChange: (channel: string) => void
  dateFilter: React.ReactNode
}) {
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const colors = ['#ff7424', '#7966ea', '#20a978', '#ed2757']
  const totalPlan = rows.reduce((sum, row) => sum + Math.round(row.current.plan), 0)
  const totalActual = rows.reduce((sum, row) => sum + Math.round(row.current.actual), 0)
  const formatMoney = (value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`
  const centerX = 130
  const centerY = 118
  const outerRadius = 90
  const innerRadius = 48
  const calloutThreshold = 5
  const donutPercentage = (value: number) => value > 0 && Math.round(value) === 0 ? '<1%' : `${Math.round(value)}%`
  let startAngle = -90
  const point = (angle: number, radius: number) => {
    const radians = (angle * Math.PI) / 180
    return { x: centerX + radius * Math.cos(radians), y: centerY + radius * Math.sin(radians) }
  }
  const slices = rows.map((row, index) => {
    const percentage = totalActual ? (row.current.actual / totalActual) * 100 : 0
    const sweep = (percentage / 100) * 360
    const endAngle = startAngle + sweep
    const middleAngle = startAngle + sweep / 2
    const outerStart = point(startAngle, outerRadius)
    const outerEnd = point(endAngle, outerRadius)
    const innerStart = point(startAngle, innerRadius)
    const innerEnd = point(endAngle, innerRadius)
    const label = point(middleAngle, (outerRadius + innerRadius) / 2)
    const leaderStart = point(middleAngle, outerRadius)
    const leaderElbowRaw = point(middleAngle, outerRadius + 17)
    const side = Math.cos((middleAngle * Math.PI) / 180) >= 0 ? 1 : -1
    const leaderElbow = { x: leaderElbowRaw.x, y: Math.min(Math.max(leaderElbowRaw.y, 12), 224) }
    const leaderEnd = { x: leaderElbow.x + side * 18, y: leaderElbow.y }
    const path = sweep >= 359.999
      ? ''
      : `M ${outerStart.x} ${outerStart.y} A ${outerRadius} ${outerRadius} 0 ${sweep > 180 ? 1 : 0} 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${innerRadius} ${innerRadius} 0 ${sweep > 180 ? 1 : 0} 0 ${innerStart.x} ${innerStart.y} Z`
    const slice = { row, color: colors[index], percentage, path, label, leaderStart, leaderElbow, leaderEnd, side, full: sweep >= 359.999 }
    startAngle = endAngle
    return slice
  })
  ;([-1, 1] as const).forEach((side) => {
    const callouts = slices
      .filter((slice) => slice.percentage > 0 && slice.percentage < calloutThreshold && slice.side === side)
      .sort((a, b) => a.leaderElbow.y - b.leaderElbow.y)
    const minimumY = 14
    const maximumY = 222
    const minimumGap = 18
    callouts.forEach((slice, index) => {
      const previousY = index ? callouts[index - 1].leaderEnd.y : minimumY - minimumGap
      const nextY = Math.max(slice.leaderElbow.y, previousY + minimumGap)
      slice.leaderElbow.x = side > 0
        ? Math.max(slice.leaderStart.x + 10, centerX + 22)
        : Math.min(slice.leaderStart.x - 10, centerX - 22)
      slice.leaderElbow.y = nextY
      slice.leaderEnd.y = nextY
      slice.leaderEnd.x = side > 0 ? 226 : 34
    })
    for (let index = callouts.length - 1; index >= 0; index -= 1) {
      const nextY = index === callouts.length - 1 ? maximumY + minimumGap : callouts[index + 1].leaderEnd.y
      const adjustedY = Math.min(callouts[index].leaderEnd.y, nextY - minimumGap)
      callouts[index].leaderElbow.y = adjustedY
      callouts[index].leaderEnd.y = adjustedY
    }
  })
  const leader = rows.reduce<typeof rows[number] | null>(
    (highest, row) => !highest || row.current.actual > highest.current.actual ? row : highest,
    null,
  )
  const leaderPercentage = leader && totalActual ? (leader.current.actual / totalActual) * 100 : 0
  const leaderColor = leader ? slices.find((slice) => slice.row.category === leader.category)?.color : undefined
  const activeSlice = slices.find((slice) => slice.row.category === activeCategory) ?? null

  return <section className={`category-sales-visual ${loading ? 'is-loading' : ''}`}>
    <div className="category-performance-head">
      <div><span className="section-kicker">Category contribution</span><h3>Category Wise Sales</h3></div>
      <div className="category-performance-actions"><label><span>Channel</span><select value={channel} onChange={(event) => onChannelChange(event.target.value)}>{DASHBOARD_CHANNEL_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label></div>
    </div>
    {dateFilter}
    <div className="category-sales-layout">
      <div className="category-sales-table-wrap">
        <table className="category-sales-table">
          <thead><tr><th>Category</th><th>Plan</th><th>Actual</th><th>% Contribution</th></tr></thead>
          <tbody>
            {rows.map((row, index) => <tr key={row.category}>
              <th>{row.category}</th>
              <td>{formatMoney(row.current.plan)}</td>
              <td className="category-sales-actual">{formatMoney(row.current.actual)}</td>
              <td className="contribution-cell" style={{ borderLeftColor: colors[index], backgroundColor: `${colors[index]}18` }}><strong>{totalActual ? Math.round((row.current.actual / totalActual) * 100) : 0}%</strong></td>
            </tr>)}
            <tr className="performance-total"><th>Total</th><td>{formatMoney(totalPlan)}</td><td className="category-sales-actual">{formatMoney(totalActual)}</td><td>{totalActual ? '100%' : '0%'}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="category-pie-panel">
        <div className="category-pie-legend">
          {slices.map((slice) => <span key={slice.row.category}><i style={{ background: slice.color }} />{slice.row.category}</span>)}
        </div>
        {totalActual > 0 ? <svg className="category-pie" viewBox="0 0 260 236" role="img" aria-label="Category actual sales contribution donut chart" onMouseLeave={() => setActiveCategory(null)}>
          <defs><filter id="donut-center-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="4" floodColor="#17213a" floodOpacity=".12" /></filter></defs>
          {slices.filter((slice) => slice.row.current.actual > 0).map((slice) => <g
            className={`donut-segment ${activeCategory === slice.row.category ? 'is-active' : activeCategory ? 'is-muted' : ''}`}
            key={slice.row.category}
            role="button"
            tabIndex={0}
            aria-label={`${slice.row.category}: ${formatMoney(slice.row.current.actual)}, ${donutPercentage(slice.percentage)}`}
            onMouseEnter={() => setActiveCategory(slice.row.category)}
            onFocus={() => setActiveCategory(slice.row.category)}
            onBlur={() => setActiveCategory(null)}
          >
            {slice.full ? <circle cx={centerX} cy={centerY} r={(outerRadius + innerRadius) / 2} fill="none" stroke={slice.color} strokeWidth={outerRadius - innerRadius} /> : <path d={slice.path} fill={slice.color} />}
            {slice.percentage >= calloutThreshold
              ? <text className="donut-slice-label" x={slice.label.x} y={slice.label.y} textAnchor="middle" dominantBaseline="middle">{donutPercentage(slice.percentage)}</text>
              : <g className="donut-callout">
                  <polyline points={`${slice.leaderStart.x},${slice.leaderStart.y} ${slice.leaderElbow.x},${slice.leaderElbow.y} ${slice.leaderEnd.x},${slice.leaderEnd.y}`} fill="none" stroke={slice.color} />
                  <circle cx={slice.leaderEnd.x} cy={slice.leaderEnd.y} r="2.5" fill={slice.color} />
                  <text x={slice.leaderEnd.x + slice.side * 6} y={slice.leaderEnd.y} textAnchor={slice.side > 0 ? 'start' : 'end'} dominantBaseline="middle">{donutPercentage(slice.percentage)}</text>
                </g>}
          </g>)}
          <circle className="donut-center" cx={centerX} cy={centerY} r={innerRadius - 1} filter="url(#donut-center-shadow)" />
          <text className="donut-center-title" x={centerX} y={centerY - (activeSlice ? 13 : 7)} textAnchor="middle">{activeSlice?.row.category ?? 'Total Sales'}</text>
          <text className="donut-center-value" x={centerX} y={centerY + (activeSlice ? 5 : 13)} textAnchor="middle">{formatMoney(activeSlice?.row.current.actual ?? totalActual)}</text>
          {activeSlice && <text className="donut-center-percent" x={centerX} y={centerY + 20} textAnchor="middle">{donutPercentage(activeSlice.percentage)}</text>}
        </svg> : <div className="category-pie-empty">No sales data for this selection</div>}
      </div>
    </div>
    <div className="category-contribution-legend" aria-label="Category contribution color legend"><strong>% Contribution colors</strong>{slices.map((slice) => <span key={slice.row.category}><i style={{ background: slice.color }} />{slice.row.category}</span>)}</div>
    <div className="category-sales-insight">
      <span style={{ color: leaderColor }}>✦</span>
      <p>{leader && totalActual > 0
        ? <><strong style={{ color: leaderColor }}>{leader.category}</strong> contributed <strong>{formatMoney(leader.current.actual)}</strong>, accounting for <strong className="insight-contribution" style={{ color: leaderColor, backgroundColor: `${leaderColor}18` }}>{Math.round(leaderPercentage)}%</strong> of total sales of <strong>{formatMoney(totalActual)}</strong>.</>
        : 'No category sales were recorded for the selected period and channel.'}</p>
    </div>
  </section>
}

function ProductRankings({
  data,
  loading,
  channel,
  onChannelChange,
  dateFilter,
}: {
  data: DashboardData['product_performance']
  loading: boolean
  channel: string
  onChannelChange: (channel: string) => void
  dateFilter?: React.ReactNode
}) {
  const [detailCategory, setDetailCategory] = useState('all')
  const money = (value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`
  const productParts = (name: string) => { const match = name.match(/^(.*?)(?:\s*[·|]\s*|\s+)([A-Z0-9]{2,}(?:-[A-Z0-9]+)+)$/i); return { title: match?.[1]?.trim() || name, sku: match?.[2] || '' } }
  const list = (items: { name: string; amount: number }[], tone: 'top' | 'bottom') => {
    const maximum = Math.max(...items.map((item) => item.amount), 1)
    return items.length ? <div className={`product-rank-items ${tone}`} role="list" aria-label={`${tone === 'top' ? 'Top 5 highest' : 'Bottom 5 lowest'} product sales`}>{items.map((item, index) => {
      const parts = productParts(item.name)
      const isChannelTop = tone === 'top' && index === 0
      return <div className={`product-rank-row ${isChannelTop ? 'is-channel-top' : ''}`} role="listitem" aria-label={isChannelTop ? `Top product by channel: ${item.name}, ${money(item.amount)}` : undefined} key={`${item.name}-${index}`}>
        <span className="product-rank-number">{index + 1}</span>
        <span className="product-rank-name" title={item.name}><span>{parts.title}</span>{parts.sku && <small>· {parts.sku}</small>}{isChannelTop && <em>Top product</em>}</span>
        <strong className={tone}>{money(item.amount)}</strong>
        <span className="product-magnitude-track" aria-hidden="true"><i style={{ width: `${Math.max((item.amount / maximum) * 100, item.amount ? 2 : 0)}%` }} /></span>
      </div>
    })}</div> : <div className="product-rank-empty">No product sales for this selection</div>
  }

  const details = (data.details ?? []).filter((row) => !`${row.category} ${row.description}`.toLocaleLowerCase().includes('language lab'))
  const channels = [...new Set(details.map((row) => row.channel))]
  const categories = [...new Set(details.map((row) => row.category).filter(Boolean))]
  const filteredDetails = details.filter((row) => detailCategory === 'all' || row.category === detailCategory)
  const filteredChannelRankings = channels.map((channel) => {
    const productTotals = new Map<string, number>()
    filteredDetails.filter((row) => row.channel === channel).forEach((row) => productTotals.set(row.description, (productTotals.get(row.description) ?? 0) + row.total_invoice_value))
    const ranked = [...productTotals].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount)
    const top = ranked.slice(0, 5)
    const topNames = new Set(top.map((item) => item.name))
    const bottom = ranked.filter((item) => !topNames.has(item.name)).reverse().slice(0, 5)
    return { channel, count: ranked.length, top, bottom }
  })
  const topProductChannels = [...filteredChannelRankings].sort((left, right) => (right.top[0]?.amount ?? 0) - (left.top[0]?.amount ?? 0))
  const TOP_PRODUCT_BAR_BASELINE = Math.max(...topProductChannels.map((channel) => channel.top[0]?.amount ?? 0), 1)
  const strongestChannel = topProductChannels[0]

  return <section className={`product-rankings product-performance-page ${loading ? 'is-loading' : ''}`}>
    <div className="category-performance-head">
      <div><span className="section-kicker">Product performance</span><h3>Product Performance</h3></div>
    </div>
    <div className="product-detail-controls"><label><span>Channel</span><select value={channel} onChange={(event) => onChannelChange(event.target.value)}>{DASHBOARD_CHANNEL_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label><span>Category</span><select value={detailCategory} onChange={(event) => setDetailCategory(event.target.value)}><option value="all">All Categories</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></label></div>
    {dateFilter}
    <div className="category-performance-head product-ranking-head"><div><span className="section-kicker">Channel leaders</span><h3>Top Product by Channel</h3><p>{detailCategory === 'all' ? 'All categories' : detailCategory} · highest-selling product in each channel, selected period</p></div></div>
    <div className="top-channel-products product-filtered-leaders" role="list" aria-label="Top product in each channel">{topProductChannels.map((channel) => {
      const product = channel.top[0]
      const [mainTitle, ...tailParts] = product?.name.split('|').map((part) => part.trim()) ?? []
      const percentage = product ? (product.amount / TOP_PRODUCT_BAR_BASELINE) * 100 : 0
      return <div className="top-channel-product" role="listitem" key={channel.channel}>
        <strong className="top-channel-name">{channel.channel}</strong>
        {product ? <><p title={product.name}><span>{mainTitle}</span>{tailParts.length > 0 && <small>{tailParts.join(' · ')}</small>}</p><strong className="top-product-value">{money(product.amount)}</strong><div className="top-product-bar" aria-hidden="true"><span style={{ width: `${percentage}%` }} /></div></> : <span className="detail-empty">No Data Available</span>}
      </div>
    })}<div className="top-product-footnote">Bar length compares each channel's top product with the strongest overall ({strongestChannel?.channel ?? 'No channel'}, {money(strongestChannel?.top[0]?.amount ?? 0)}).</div></div>
    <div className="category-performance-head product-ranking-head"><div><span className="section-kicker">Product ranking</span><h3>Top 5 / Bottom 5 Products</h3></div></div>
    <div className="product-channel-sections">
      {filteredChannelRankings.map((channel) => <article className="product-channel-section" key={channel.channel}>
        <div className="product-channel-heading"><strong>{channel.channel}</strong><span className="product-range-summary"><b>Top</b><strong>{money(channel.top[0]?.amount ?? 0)}</strong><i>·</i><b>bottom</b><strong>{money(channel.bottom[0]?.amount ?? 0)}</strong></span></div>
        <div className="product-rankings-grid">
          <div className="product-rank-list">
            <div className="product-rank-title top"><span>↓</span><div><strong>Top 5 · highest sales</strong><small>Largest to smallest</small></div></div>
            {list(channel.top, 'top')}
          </div>
          <div className="product-rank-list">
            <div className="product-rank-title bottom"><span>↑</span><div><strong>Bottom 5 · lowest sales</strong><small>Smallest to largest</small></div></div>
            {list(channel.bottom, 'bottom')}
          </div>
        </div>
      </article>)}
    </div>
    <div className="product-ranking-footnote"><span><i className="top" />Share of that channel's top seller</span><span><i className="bottom" />Share of that list's highest value</span><small>Bars are scaled within each list and are not comparable across panels.</small></div>
  </section>
}

function CustomersByEmail({
  data,
  loading,
  period,
  orderDetails,
  channel,
  onChannelChange,
  dateFilter,
}: {
  data: DashboardData['customer_performance']
  loading: boolean
  period: string
  orderDetails: DashboardData['state_order_details']
  channel: string
  onChannelChange: (channel: string) => void
  dateFilter: React.ReactNode
}) {
  const [tableOpen, setTableOpen] = useState(false)
  const [orderChannel, setOrderChannel] = useState('all')
  const [orderCategory, setOrderCategory] = useState('all')
  const [cohort, setCohort] = useState<'all' | 'new' | 'returning'>('all')
  const filteredOrders = orderDetails.filter((row) => row.email && (orderChannel === 'all' || row.channel === orderChannel) && (orderCategory === 'all' || row.category === orderCategory))
  const orderCategories = [...new Set(orderDetails.map((row) => row.category).filter(Boolean))].sort()
  const emailCounts = filteredOrders.reduce<Record<string, number>>((counts, row) => { const email = row.email!.toLowerCase(); counts[email] = (counts[email] ?? 0) + 1; return counts }, {})
  // Cohorts are mutually exclusive in the active filtered primary dataset.
  const orders = filteredOrders.filter((row) => cohort === 'all' || (cohort === 'new'
    ? emailCounts[row.email!.toLowerCase()] === 1
    : emailCounts[row.email!.toLowerCase()] > 1))
  const cohortSales = orders.reduce((sum, row) => sum + row.sales, 0)
  const cohortOrders = new Set(orders.map((row) => `${row.channel}:${row.order_id || `${row.year}-${row.month}-${row.email}-${row.description}`}`)).size
  const money = (value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`
  const delta = data.repeat_rate_delta ?? 0
  const downloadCustomerOrders = () => downloadCsv(
    `customer-${cohort}-orders.csv`,
    ['Year', 'Month', 'Email ID', 'Channel', 'Category', 'Description', 'Qty', 'Sales'],
    orders.map((row) => [row.year, row.month, row.email ?? '', row.channel, row.category, row.description, row.quantity, row.sales]),
  )
  const priorMonth = data.trend?.at(-2)
  const priorMonthLabel = priorMonth ? new Date(`${priorMonth.key}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }) : 'prior month'
  useEffect(() => {
    if (data.unique_customers + data.repeat_customers !== data.total_customers) console.warn('Customer mix totals do not reconcile.', data)
  }, [data])
  return <section id="customer-performance-visual" className={`dashboard-detail-card ${loading ? 'is-loading' : ''}`}>
    <div className="customer-mix-card-head"><div><span className="section-kicker">Customer mix</span><h3>New vs returning customers</h3><p>New = first ever purchase in {period} · returning = purchased before</p></div><div className="customer-mix-total"><strong>{data.total_customers.toLocaleString('en-IN')}</strong><span>identified customers</span></div></div>
    <div className="detail-card-head"><span className="detail-card-icon">＠</span><div><span className="section-kicker">Customer frequency</span><h3>Customers by Email</h3></div></div>
    {data.total_customers ? <div className="customer-mix customer-mix-interactive" role="button" tabIndex={0} onClick={(event) => { setCohort((event.target as Element).classList.contains('repeat') ? 'returning' : 'new'); setTableOpen(true) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setTableOpen(true) } }}>
      <div className="customer-mix-bar" aria-label={`${Math.round(data.unique_percent)}% new customers and ${Math.round(data.repeat_percent)}% returning customers`}>
        <span className="unique" style={{ width: `${data.unique_percent}%` }}>New · {data.unique_customers.toLocaleString('en-IN')} · {Math.round(data.unique_percent)}%</span>
        <span className="repeat" style={{ width: `${data.repeat_percent}%` }}>{data.repeat_customers.toLocaleString('en-IN')} · {Math.round(data.repeat_percent)}%</span>
      </div>
      <div className="customer-mix-values">
        <div><span><i className="unique" />New customers</span><strong>{data.unique_customers.toLocaleString('en-IN')}</strong></div>
        <div><span><i className="repeat" />Returning customers</span><strong>{data.repeat_customers.toLocaleString('en-IN')}</strong></div>
      </div>
    </div> : <div className="detail-empty detail-empty-large">No Data Available</div>}
    <div className="customer-kpi-filters"><label><span>Channel</span><select value={channel} onChange={(event) => onChannelChange(event.target.value)}>{DASHBOARD_CHANNEL_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>{dateFilter}</div>
    <div className="customer-metrics" aria-label="Customer performance KPIs">
      <div className="is-drilldown" role="button" tabIndex={0} aria-label="View all identified customer orders" onClick={() => { setCohort('all'); setTableOpen(true) }}><span>Identified customers</span><strong>{data.total_customers.toLocaleString('en-IN')}</strong><em>Click to view orders →</em></div><div className="is-drilldown" role="button" tabIndex={0} aria-label="View new customer orders" onClick={() => { setCohort('new'); setTableOpen(true) }}><span>New customers</span><strong>{data.unique_customers.toLocaleString('en-IN')} <small>{Math.round(data.unique_percent)}%</small></strong><em>Click to view orders →</em></div><div className="is-drilldown" role="button" tabIndex={0} aria-label="View returning customer orders" onClick={() => { setCohort('returning'); setTableOpen(true) }}><span>Returning customers</span><strong>{data.repeat_customers.toLocaleString('en-IN')} <small>{Math.round(data.repeat_percent)}%</small></strong><em>Click to view orders →</em></div><div><span>Repeat rate vs {priorMonthLabel}</span><strong className={delta < 0 ? 'is-down' : 'is-up'}>{delta >= 0 ? '↑ +' : '↘ '}{Math.abs(delta).toFixed(1)}pt</strong></div>
    </div>
    {data.total_customers ? <div className="customer-split-bar" aria-label={`${Math.round(data.unique_percent)}% new customers and ${Math.round(data.repeat_percent)}% returning customers`}><span className="new" style={{ width: `${data.unique_percent}%` }}>New · {data.unique_customers.toLocaleString('en-IN')} · {Math.round(data.unique_percent)}%</span><span className="returning" style={{ width: `${data.repeat_percent}%` }}>{data.repeat_customers.toLocaleString('en-IN')} · {Math.round(data.repeat_percent)}%</span></div> : <div className="detail-empty">No customer data available</div>}
    {tableOpen && <div className="customer-orders"><div className="customer-orders-head"><strong>{cohort === 'all' ? 'All identified customers' : cohort === 'new' ? 'New customers' : 'Returning customers'}</strong><label>Channel <select value={orderChannel} onChange={(event) => setOrderChannel(event.target.value)}>{DASHBOARD_RECORD_CHANNEL_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label>Category <select value={orderCategory} onChange={(event) => setOrderCategory(event.target.value)}><option value="all">All categories</option>{orderCategories.map((category) => <option key={category} value={category}>{category}</option>)}</select></label><button type="button" disabled={!orders.length} onClick={downloadCustomerOrders}>↓ Download CSV</button><button type="button" onClick={() => setTableOpen(false)}>Close</button></div><div className="customer-orders-date-filter">{dateFilter}</div><div className="customer-table-kpis"><div><span>Total sales</span><strong>{money(cohortSales)}</strong></div><div><span>Total orders</span><strong>{cohortOrders.toLocaleString('en-IN')}</strong></div></div><table><thead><tr><th>Year</th><th>Month</th><th>Email ID</th><th>Category</th><th>Description</th><th>Qty</th><th>Sales</th></tr></thead><tbody>{orders.map((row, index) => <tr key={`${row.order_id}-${index}`}><td>{row.year}</td><td>{row.month}</td><td>{row.email}</td><td>{row.category}</td><td>{row.description}</td><td>{row.quantity}</td><td>{row.sales.toLocaleString('en-IN')}</td></tr>)}</tbody></table></div>}
  </section>
}

function FinancialBreakdown({ data, loading, channel, onChannelChange, dateFilter }: { data: DashboardData['financial_breakdown']; loading: boolean; channel: string; onChannelChange: (channel: string) => void; dateFilter: React.ReactNode }) {
  const channelNames: Record<string, string> = { dsg: 'DSG', sfh: 'SFH', amazon: 'Amazon', direct: 'Direct Sales' }
  const channels = channel === 'all' ? ['DSG', 'SFH', 'Amazon', 'Direct Sales'] : [channelNames[channel]].filter(Boolean)
  const formatValue = (value: number) => value === 0 ? '–' : Math.round(value).toLocaleString('en-IN')
  const rows = [
    { key: 'basic_value', label: 'Basic value' },
    { key: 'shipping', label: 'Shipping' },
    { key: 'discount', label: 'Discount' },
    { key: 'taxable_value', label: 'Taxable value' },
    { key: 'total_tax', label: 'Total tax' },
    { key: 'total_sale', label: 'Total sales' },
  ] as const
  const downloadFinancialBreakdown = () => downloadCsv(
    `financial-breakdown-${channel === 'all' ? 'all-channels' : channel}.csv`,
    ['Particulars', ...channels, 'Total'],
    rows.map((row) => {
      const values = channels.map((channelName) => Number(data[channelName]?.[row.key] ?? 0))
      return [row.label, ...values, values.reduce((sum, value) => sum + value, 0)]
    }),
  )
  return <section className={`financial-breakdown-card ${loading ? 'is-loading' : ''}`}>
    <div className="financial-breakdown-head"><div><h3>Financial breakdown</h3><p>Financial values use the same channel rules as the Summary report.</p></div><button className="table-download-button" type="button" disabled={loading} onClick={downloadFinancialBreakdown}>↓ Download CSV</button></div>
    <div className="financial-breakdown-filters"><label><span>Channel</span><select value={channel} onChange={(event) => onChannelChange(event.target.value)}>{DASHBOARD_CHANNEL_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>{dateFilter}</div>
    <div className="financial-breakdown-wrap"><table className="financial-breakdown-table"><thead><tr><th>Particulars</th>{channels.map((channel) => <th key={channel}>{channel}</th>)}<th>Total</th></tr></thead><tbody>{rows.map((row) => {
      const total = channels.reduce((sum, channel) => sum + Number(data[channel]?.[row.key] ?? 0), 0)
      const showBars = row.key === 'basic_value' || row.key === 'taxable_value'
      const magnitude = Math.max(channels.reduce((sum, channel) => sum + Math.abs(Number(data[channel]?.[row.key] ?? 0)), 0), 1)
      return <tr className={row.key === 'total_sale' ? 'financial-total-row' : ''} key={row.key}><th>{row.label}</th>{channels.map((channel) => { const value = Number(data[channel]?.[row.key] ?? 0); const share = Math.abs(value) / magnitude * 100; return <td className={row.key === 'discount' && value < 0 ? 'negative' : ''} key={channel}><span>{formatValue(value)}</span>{showBars && value !== 0 && <i className="financial-value-track" aria-hidden="true"><i className="financial-value-bar" style={{ width: `${share}%` }} /></i>}</td> })}<td className={row.key === 'discount' && total < 0 ? 'negative' : ''}><span>{formatValue(total)}</span></td></tr>
    })}</tbody></table></div>
  </section>
}

const STATE_SHARE_COLLAPSE_THRESHOLD = 1
const STATE_TAIL_COLLAPSE_MINIMUM = 5

function StateWisePerformance({ rows, orderDetails, loading, filters }: { rows: DashboardData['state_performance']; orderDetails: DashboardData['state_order_details']; loading: boolean; filters?: React.ReactNode }) {
  const [expandedTails, setExpandedTails] = useState<Record<string, boolean>>({})
  const [ordersPageOpen, setOrdersPageOpen] = useState(false)
  const [orderScope, setOrderScope] = useState<'india' | 'international' | 'invalid'>('india')
  const [selectedState, setSelectedState] = useState<string | null>(null)
  const [orderChannel, setOrderChannel] = useState('all')
  const [orderCategory, setOrderCategory] = useState('all')
  const [orderSort, setOrderSort] = useState<{ key: keyof DashboardData['state_order_details'][number]; direction: 'asc' | 'desc' }>({ key: 'year', direction: 'desc' })
  const total = rows.reduce((sum, row) => sum + Math.round(row.amount), 0)
  const indianRows = rows.filter((row) => row.state.endsWith(', India'))
  const invalidRows = rows.filter((row) => row.state === 'Unknown/Invalid')
  const nonIndianRows = rows.filter((row) => !row.state.endsWith(', India') && row.state !== 'Unknown/Invalid')
  const validRows = [...indianRows, ...nonIndianRows]
  const maximum = Math.max(...validRows.map((row) => row.amount), 1)
  const indianTotal = indianRows.reduce((sum, row) => sum + Math.round(row.amount), 0)
  const nonIndianTotal = nonIndianRows.reduce((sum, row) => sum + Math.round(row.amount), 0)
  const invalidTotal = invalidRows.reduce((sum, row) => sum + Math.round(row.amount), 0)
  const invalidOrders = invalidRows.reduce((sum, row) => sum + (row.orders ?? 0), 0)
  const share = (value: number) => total ? (value / total) * 100 : 0
  const format = (value: number) => Math.round(value).toLocaleString('en-IN')
  const shortName = (state: string, india: boolean) => {
    if (india) return state.replace(/, India$/, '')
    const separator = state.lastIndexOf(', ')
    if (separator < 0) return state
    const region = state.slice(0, separator)
    const country = state.slice(separator + 2)
    return `${region} · ${country === 'United States' ? 'US' : country}`
  }
  const countryTotals = nonIndianRows.reduce<Record<string, number>>((totals, row) => {
    const separator = row.state.lastIndexOf(', ')
    const country = separator < 0 ? 'Other' : row.state.slice(separator + 2)
    const label = country === 'United States' ? 'US' : country
    totals[label] = (totals[label] ?? 0) + Math.round(row.amount)
    return totals
  }, {})
  const countryBreakdownEntries = Object.entries(countryTotals).sort((a, b) => b[1] - a[1])
  const countryBreakdown = [
    ...countryBreakdownEntries.slice(0, 3).map(([country, value]) => `${country} ${format(value)}`),
    ...(countryBreakdownEntries.length > 3 ? [`Others ${format(countryBreakdownEntries.slice(3).reduce((sum, [, value]) => sum + value, 0))}`] : []),
  ].join(' · ')
  const groups = [
    { id: 'india', title: 'India', noun: 'states', rows: indianRows, total: indianTotal, india: true, breakdown: '' },
    { id: 'international', title: 'Other countries', noun: 'regions', rows: nonIndianRows, total: nonIndianTotal, india: false, breakdown: countryBreakdown },
  ]
  const topLocation = validRows.reduce<(typeof validRows)[number] | undefined>((top, row) => !top || row.amount > top.amount ? row : top, undefined)
  const scopedOrderDetails = orderDetails.filter((row) => row.classification === orderScope && (!selectedState || row.state === selectedState))
  const orderCategories = [...new Set(scopedOrderDetails.map((row) => row.category).filter(Boolean))].sort()
  const visibleOrderDetails = scopedOrderDetails
    .filter((row) => (orderChannel === 'all' || row.channel === orderChannel) && (orderCategory === 'all' || row.category === orderCategory))
    .sort((a, b) => {
      const left = a[orderSort.key]
      const right = b[orderSort.key]
      const comparison = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right))
      return orderSort.direction === 'asc' ? comparison : -comparison
    })
  const visibleOrderQuantity = visibleOrderDetails.reduce((sum, row) => sum + row.quantity, 0)
  const visibleOrderSales = visibleOrderDetails.reduce((sum, row) => sum + row.sales, 0)
  const sortOrders = (key: keyof DashboardData['state_order_details'][number]) => setOrderSort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }))
  const downloadVisibleOrders = () => downloadCsv(
    `state-orders-${selectedState ?? orderScope}.csv`,
    ['Year', 'Month', 'Channel', 'Category', 'Description', 'QTY', 'Sales'],
    visibleOrderDetails.map((row) => [row.year, new Date(2000, row.month - 1, 1).toLocaleString('en-IN', { month: 'short' }), row.channel, row.category, row.description, row.quantity, row.sales]),
  )
  const selectOrderScope = (scope: 'india' | 'international' | 'invalid') => {
    setOrderScope(scope)
    setSelectedState(null)
    setOrderChannel('all')
    setOrderCategory('all')
    setOrdersPageOpen(true)
  }

  useEffect(() => {
    if (indianTotal + nonIndianTotal + invalidTotal !== total) {
      console.warn('State Wise Performance totals do not reconcile.', { indianTotal, nonIndianTotal, invalidTotal, total })
    }
  }, [indianTotal, nonIndianTotal, invalidTotal, total])
  useEffect(() => {
    // TODO: Verify Texas and Washington against raw order addresses; do not alter them here.
    if (rows.some((row) => row.state.startsWith('Texas, ') || row.state.startsWith('Washington, '))) console.warn('Location data check: verify Texas and Washington against raw order addresses.')
    // TODO: Confirm whether Gujarat is genuine new business or reflects a location-mapping change.
    if (rows.some((row) => row.state === 'Gujarat, India')) console.warn('Location data check: confirm the Gujarat mapping/change against the source period.')
  }, [rows])
  return <section id="state-performance-visual" className={`dashboard-detail-card state-performance ${ordersPageOpen ? 'state-orders-page-open' : ''} ${loading ? 'is-loading' : ''}`}>
    <div className="state-location-header"><div><span className="section-kicker">Geographic sales</span><h3>Sales by location</h3></div><div className="state-location-summary"><strong>{format(total)}</strong><span>{rows.length} {rows.length === 1 ? 'location' : 'locations'}</span></div></div>
    <div className="detail-card-head"><span className="detail-card-icon">⌖</span><div><span className="section-kicker">Geographic sales</span><h3>State Wise Performance</h3></div></div>
    {filters}
    {rows.length ? <div className="state-location-content">
      <div className="state-location-proportion" aria-label={`India ${share(indianTotal).toFixed(1)}%, other countries ${share(nonIndianTotal).toFixed(1)}%, unknown ${share(invalidTotal).toFixed(1)}%`}>
        {indianTotal > 0 && <span className="india" title={`India: ${format(indianTotal)} (${share(indianTotal).toFixed(1)}%)`} style={{ width: `${share(indianTotal)}%` }} />}
        {nonIndianTotal > 0 && <button type="button" className="international" aria-label={`View other-country orders: ${format(nonIndianTotal)} (${share(nonIndianTotal).toFixed(1)}%)`} aria-pressed={orderScope === 'international'} title={`Other countries: ${format(nonIndianTotal)} (${share(nonIndianTotal).toFixed(1)}%)`} onClick={() => selectOrderScope('international')} style={{ width: `${share(nonIndianTotal)}%` }} />}
        {invalidTotal > 0 && <button type="button" className="invalid" aria-label={`View unknown-location orders: ${format(invalidTotal)} (${share(invalidTotal).toFixed(1)}%)`} aria-pressed={orderScope === 'invalid'} title={`Unknown: ${format(invalidTotal)} (${share(invalidTotal).toFixed(1)}%)`} onClick={() => selectOrderScope('invalid')} style={{ width: `${share(invalidTotal)}%` }} />}
      </div>
      <div className="state-location-legend">
        <span><i className="india" />India <strong>{format(indianTotal)}</strong> ({share(indianTotal).toFixed(1)}%)</span>
        <span><i className="international" />Other countries <strong>{format(nonIndianTotal)}</strong> ({share(nonIndianTotal).toFixed(1)}%)</span>
        <span><i className="invalid" />Unknown <strong>{format(invalidTotal)}</strong> ({share(invalidTotal).toFixed(1)}%)</span>
      </div>
      <p className="state-location-drilldown-hint"><span aria-hidden="true">↗</span> Click a location bar to view its order table.</p>
      <div className="state-location-groups">
        {groups.map((group) => {
          const tailRows = group.rows.filter((row) => share(row.amount) < STATE_SHARE_COLLAPSE_THRESHOLD)
          const collapseTail = tailRows.length > STATE_TAIL_COLLAPSE_MINIMUM
          const tailExpanded = Boolean(expandedTails[group.id])
          const displayedRows = collapseTail && !tailExpanded ? group.rows.filter((row) => share(row.amount) >= STATE_SHARE_COLLAPSE_THRESHOLD) : group.rows
          const tailTotal = tailRows.reduce((sum, row) => sum + Math.round(row.amount), 0)
          return <section className="state-location-group" key={group.title}>
          <div className="state-location-group-head">
            <h4>{group.title} <span>· {group.rows.length} {group.rows.length === 1 ? group.noun.slice(0, -1) : group.noun}</span></h4>
            {group.breakdown && <small>{group.breakdown}</small>}
            <strong>{format(group.total)}</strong>
          </div>
          <div className="state-location-rows">
            {displayedRows.length ? displayedRows.map((row) => <div className={`state-location-row state-location-selectable${selectedState === row.state ? ' is-selected' : ''}`} key={row.state} role="button" tabIndex={0} aria-label={`View orders for ${row.state}`} onClick={() => { setOrderScope(group.india ? 'india' : 'international'); setSelectedState(row.state); setOrderChannel('all'); setOrderCategory('all'); setOrdersPageOpen(true) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOrderScope(group.india ? 'india' : 'international'); setSelectedState(row.state); setOrderChannel('all'); setOrderCategory('all'); setOrdersPageOpen(true) } }}>
              <span className="state-location-name">{shortName(row.state, group.india)}</span>
              <span className={`state-location-bar ${group.india ? 'india' : 'international'}`} aria-hidden="true"><i style={{ width: `${Math.max((row.amount / maximum) * 100, row.amount ? 1 : 0)}%` }} /></span>
              <strong>{format(row.amount)}</strong>
              <span className="state-location-share">{share(row.amount).toFixed(1)}%</span>
            </div>) : <p className="state-location-empty">No data available</p>}
            {collapseTail && <div className="state-location-row state-location-tail-summary">
              <button type="button" aria-expanded={tailExpanded} onClick={() => setExpandedTails((current) => ({ ...current, [group.id]: !tailExpanded }))}><span aria-hidden="true">{tailExpanded ? '⌃' : '⌄'}</span>{tailRows.length} {group.noun} below {STATE_SHARE_COLLAPSE_THRESHOLD}%</button>
              <span />
              <strong>{format(tailTotal)}</strong>
              <span className="state-location-share">{share(tailTotal).toFixed(1)}%</span>
            </div>}
          </div>
        </section> })}
      </div>
      {invalidTotal > 0 && <div className="state-location-warning" role="note">
        <span className="state-location-warning-icon" aria-hidden="true">!</span>
        <button type="button" onClick={() => selectOrderScope('invalid')}>View orders</button>
        <p>Unknown / invalid location <strong>{' · '}{format(invalidTotal)}</strong> across <strong>{invalidOrders.toLocaleString('en-IN')} orders</strong></p>
      </div>}
      <div className="state-location-grand-total"><span>Grand total {' · '}{rows.length} {rows.length === 1 ? 'location' : 'locations'}</span><i /><strong>{format(total)}</strong><span>100%</span></div>
      {topLocation && <p className="state-location-footnote">Bars scaled against {shortName(topLocation.state, topLocation.state.endsWith(', India'))} ({format(topLocation.amount)}). Share % is of the {format(total)} total.</p>}
      <section className="state-orders-detail" aria-labelledby="state-orders-title">
        <button className="state-orders-back" type="button" onClick={() => setOrdersPageOpen(false)}>← Back to State Performance</button>
        <div className="state-orders-head"><div><span className="section-kicker">Order drill-down</span><h4 id="state-orders-title">View Orders</h4></div><div className="state-orders-head-actions"><span>{visibleOrderDetails.length.toLocaleString('en-IN')} rows</span><button type="button" disabled={!visibleOrderDetails.length} onClick={downloadVisibleOrders}>↓ Download CSV</button></div></div>
        <div className="state-orders-scopes" role="group" aria-label="Order location category">
          {([
            ['india', 'India'],
            ['international', 'Other Countries'],
            ['invalid', 'Unknown / Invalid Location'],
          ] as const).map(([scope, label]) => <button className={orderScope === scope ? 'active' : ''} type="button" key={scope} onClick={() => selectOrderScope(scope)}>{label}</button>)}
        </div>
        {selectedState && <div className="state-orders-selection"><span>Showing orders for <strong>{selectedState}</strong></span><button type="button" onClick={() => setSelectedState(null)}>Clear state</button></div>}
        <div className="state-orders-filters">
          <label><span>Channel</span><select value={orderChannel} onChange={(event) => setOrderChannel(event.target.value)}>{DASHBOARD_RECORD_CHANNEL_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
          <label><span>Category</span><select value={orderCategory} onChange={(event) => setOrderCategory(event.target.value)}><option value="all">All Categories</option>{orderCategories.map((category) => <option value={category} key={category}>{category}</option>)}</select></label>
        </div>
        <div className="state-orders-table-wrap">
          <table className="state-orders-table">
            <thead><tr>{([
              ['year', 'Year'], ['month', 'Month'], ['channel', 'Channel'],
              ['category', 'Category'], ['description', 'Description'], ['quantity', 'QTY'], ['sales', 'Sales'],
            ] as const).map(([key, label]) => <th key={key}><button type="button" onClick={() => sortOrders(key)}>{label}{orderSort.key === key ? <span aria-hidden="true">{orderSort.direction === 'asc' ? ' ↑' : ' ↓'}</span> : null}</button></th>)}</tr></thead>
            <tbody>{visibleOrderDetails.length ? visibleOrderDetails.map((row, index) => <tr key={`${row.channel}-${row.order_id}-${row.state}-${index}`}>
              <td>{row.year}</td><td>{new Date(2000, row.month - 1, 1).toLocaleString('en-IN', { month: 'short' })}</td><td>{row.channel}</td><td>{row.category || '—'}</td><td>{row.description || '—'}</td><td>{row.quantity.toLocaleString('en-IN')}</td><td>{format(row.sales)}</td>
            </tr>) : <tr><td className="state-orders-empty" colSpan={7}>No orders available for this location category.</td></tr>}</tbody>
            {visibleOrderDetails.length > 0 && <tfoot><tr><th colSpan={5}>Grand Total · {visibleOrderDetails.length.toLocaleString('en-IN')} rows</th><th>{visibleOrderQuantity.toLocaleString('en-IN')}</th><th>{format(visibleOrderSales)}</th></tr></tfoot>}
          </table>
        </div>
      </section>
    </div> : <div className="detail-empty detail-empty-large">No state data available</div>}
  </section>
}

function DashboardPage() {
  const today = new Date()
  const initialMonth = String(today.getMonth() + 1)
  const initialYear = today.getFullYear()
  const previousDate = new Date(initialYear, today.getMonth() - 1, 1)
  const defaults: DashboardFilters = {
    channel: 'all',
    time: { grain: 'monthly', period: initialMonth },
    year: initialYear,
    comparison: { grain: 'monthly', period: String(previousDate.getMonth() + 1) },
    comparisonYear: previousDate.getFullYear(),
  }
  const [initialFilters] = useState(() => savedDashboardFilters(defaults))
  const [data, setData] = useState<DashboardData | null>(null)
  const [detailData, setDetailData] = useState<Partial<Record<Exclude<DashboardView, 'overview'>, DashboardData>>>({})
  const [detailLoading, setDetailLoading] = useState(false)
  const [globalChannel, setGlobalChannelState] = useState(initialFilters.channel)
  const [time, setTime] = useState<TimeSelection>(initialFilters.time)
  const [activeYear, setActiveYear] = useState(initialFilters.year)
  const [comparison, setComparison] = useState<TimeSelection>(initialFilters.comparison)
  const [comparisonYear, setComparisonYear] = useState(initialFilters.comparisonYear)
  const [draftChannel, setDraftChannel] = useState(initialFilters.channel)
  const [draftTime, setDraftTime] = useState<TimeSelection>(initialFilters.time)
  const [draftYear, setDraftYear] = useState(initialFilters.year)
  const [draftComparison, setDraftComparison] = useState<TimeSelection>(initialFilters.comparison)
  const [draftComparisonYear, setDraftComparisonYear] = useState(initialFilters.comparisonYear)
  const [dashboardView, setDashboardView] = useState<DashboardView>('overview')
  const [pageFilters, setPageFilters] = useState<Record<DashboardView, DashboardPageFilter>>({
    overview: { channel: null, dateFilterMode: 'range', dateStart: '', dateEnd: '' },
    product: { channel: null, dateFilterMode: 'range', dateStart: '', dateEnd: '' },
    state: { channel: null, dateFilterMode: 'range', dateStart: '', dateEnd: '' },
    customer: { channel: null, dateFilterMode: 'range', dateStart: '', dateEnd: '' },
    financial: { channel: null, dateFilterMode: 'range', dateStart: '', dateEnd: '' },
  })
  const { dateFilterMode, dateStart, dateEnd } = pageFilters[dashboardView]
  const updatePageFilter = (change: Partial<DashboardPageFilter>) => setPageFilters((current) => ({
    ...current,
    [dashboardView]: { ...current[dashboardView], ...change },
  }))
  const setDateFilterMode = (value: DashboardPageFilter['dateFilterMode']) => updatePageFilter({ dateFilterMode: value })
  const setDateStart = (value: string) => updatePageFilter({ dateStart: value })
  const setDateEnd = (value: string) => updatePageFilter({ dateEnd: value })
  const detailView = dashboardView === 'overview' ? null : dashboardView
  const effectiveChannel = detailView ? (pageFilters[detailView].channel ?? globalChannel) : globalChannel
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // Show the KPI detail panels on first load; All Channels also reopens every panel.
  const [expanded, setExpanded] = useState<string | null>('all')
  const [categoryPeriodView, setCategoryPeriodView] = useState<'both' | 'current' | 'comparison'>('both')
  const [channelPeriodView, setChannelPeriodView] = useState<'both' | 'current' | 'comparison'>('both')
  const [categoryChannel, setCategoryChannel] = useState(initialFilters.channel)
  const [categorySalesChannel, setCategorySalesChannel] = useState(initialFilters.channel)
  const [categoryTableData, setCategoryTableData] = useState<DashboardData | null>(null)
  const [categorySalesData, setCategorySalesData] = useState<DashboardData | null>(null)
  const [selectedChannelCell, setSelectedChannelCell] = useState<string | null>(null)
  const [categorySort, setCategorySort] = useState<{ key: string; direction: 'asc' | 'desc' }>({ key: 'category', direction: 'asc' })
  const useLatestDataPeriod = useRef(shouldUseLatestDashboardPeriod(initialYear, initialMonth))
  const skipDashboardFetch = useRef(false)
  const overviewFilters = useRef<DashboardFilters | null>(null)

  useEffect(() => {
    if (skipDashboardFetch.current) {
      skipDashboardFetch.current = false
      return
    }
    let active = true
    const query = new URLSearchParams({ channel: globalChannel, grain: time.grain })
    query.set('view', 'overview')
    if (time.period) query.set('period', time.period)
    query.set('year', String(activeYear))
    query.set('comparison_grain', comparison.grain)
    query.set('comparison_period', comparison.period)
    query.set('comparison_year', String(comparisonYear))
    if (useLatestDataPeriod.current && time.grain === 'monthly') query.set('latest', 'true')
    const requestUrl = `/api/dashboard/kpis?${query}`
    const cached = dashboardResponseCache.get(requestUrl)
    if (cached && Date.now() - cached.storedAt < DASHBOARD_CACHE_TTL_MS) {
      setData(cached.data)
      setError('')
      setLoading(false)
      return () => { active = false }
    }
    fetch(requestUrl)
      .then(async (response) => {
        const contentType = response.headers.get('content-type') ?? ''
        if (!contentType.includes('application/json')) {
          throw new Error(
            response.ok
              ? 'The API returned an invalid response.'
              : `The API is unavailable (HTTP ${response.status}). Check the deployment configuration.`,
          )
        }
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail ?? 'Unable to load dashboard KPIs.')
        return result
      })
      .then((result: DashboardData) => {
        if (active) {
          dashboardResponseCache.set(requestUrl, { data: result, storedAt: Date.now() })
          if (!result.available_years.includes(result.selected_year)) {
            const fallbackYear = result.available_years[0] ?? initialYear
            const fallbackTime = time.grain === 'yearly' ? { ...time, period: String(fallbackYear) } : time
            const fallbackFilters = {
              channel: globalChannel,
              time: fallbackTime,
              year: fallbackYear,
              comparison,
              comparisonYear,
            }
            dashboardResponseCache.delete(requestUrl)
            localStorage.setItem(DASHBOARD_FILTERS_KEY, JSON.stringify(fallbackFilters))
            setTime(fallbackTime)
            setActiveYear(fallbackYear)
            setDraftTime(fallbackTime)
            setDraftYear(fallbackYear)
            setLoading(true)
            return
          }
          if (useLatestDataPeriod.current && time.grain === 'monthly') {
            useLatestDataPeriod.current = false
            const latestYear = result.selected_year
            const latestMonth = Number(result.selected_period)
            if (latestYear !== activeYear || String(latestMonth) !== time.period) {
                const previous = new Date(latestYear, latestMonth - 2, 1)
                const latestTime = { grain: 'monthly' as const, period: String(latestMonth) }
                const previousTime = { grain: 'monthly' as const, period: String(previous.getMonth() + 1) }
                skipDashboardFetch.current = true
                setTime(latestTime); setActiveYear(latestYear)
                setComparison(previousTime); setComparisonYear(previous.getFullYear())
                setDraftTime(latestTime); setDraftYear(latestYear)
                setDraftComparison(previousTime); setDraftComparisonYear(previous.getFullYear())
            }
          }
          setData(result)
          setError('')
        }
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load dashboard KPIs.') })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [globalChannel, time, activeYear, comparison, comparisonYear])

  useEffect(() => {
    if (!detailView) return
    let active = true
    const query = new URLSearchParams({
      channel: effectiveChannel,
      view: detailView,
      grain: time.grain,
      period: time.period,
      year: String(activeYear),
      comparison_grain: comparison.grain,
      comparison_period: comparison.period,
      comparison_year: String(comparisonYear),
    })
    const requestUrl = `/api/dashboard/kpis?${query}`
    const cached = dashboardResponseCache.get(requestUrl)
    if (cached && Date.now() - cached.storedAt < DASHBOARD_CACHE_TTL_MS) {
      setDetailData((current) => ({ ...current, [detailView]: cached.data }))
      setDetailLoading(false)
      return () => { active = false }
    }
    setDetailLoading(true)
    fetch(requestUrl)
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail ?? `Unable to load ${detailView} performance.`)
        return result as DashboardData
      })
      .then((result) => {
        if (!active) return
        dashboardResponseCache.set(requestUrl, { data: result, storedAt: Date.now() })
        setDetailData((current) => ({ ...current, [detailView]: result }))
        setError('')
      })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : `Unable to load ${detailView} performance.`) })
      .finally(() => { if (active) setDetailLoading(false) })
    return () => { active = false }
  }, [detailView, effectiveChannel, time, activeYear, comparison, comparisonYear])

  useEffect(() => {
    if (categoryChannel === globalChannel) return
    let active = true
    const query = new URLSearchParams({
      view: 'overview', channel: categoryChannel, grain: time.grain, period: time.period,
      year: String(activeYear), comparison_grain: comparison.grain,
      comparison_period: comparison.period, comparison_year: String(comparisonYear),
    })
    const requestUrl = `/api/dashboard/kpis?${query}`
    const cached = dashboardResponseCache.get(requestUrl)
    if (cached && Date.now() - cached.storedAt < DASHBOARD_CACHE_TTL_MS) {
      setCategoryTableData(cached.data)
      return
    }
    fetch(requestUrl).then(async (response) => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to load Category Wise Performance.')
      return result as DashboardData
    }).then((result) => {
      if (!active) return
      dashboardResponseCache.set(requestUrl, { data: result, storedAt: Date.now() })
      setCategoryTableData(result)
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load Category Wise Performance.') })
    return () => { active = false }
  }, [categoryChannel, globalChannel, time, activeYear, comparison, comparisonYear])

  useEffect(() => {
    if (categorySalesChannel === globalChannel) return
    let active = true
    const query = new URLSearchParams({
      view: 'overview', channel: categorySalesChannel, grain: time.grain, period: time.period,
      year: String(activeYear), comparison_grain: comparison.grain,
      comparison_period: comparison.period, comparison_year: String(comparisonYear),
    })
    const requestUrl = `/api/dashboard/kpis?${query}`
    const cached = dashboardResponseCache.get(requestUrl)
    if (cached && Date.now() - cached.storedAt < DASHBOARD_CACHE_TTL_MS) {
      setCategorySalesData(cached.data)
      return
    }
    fetch(requestUrl).then(async (response) => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to load Category Wise Sales.')
      return result as DashboardData
    }).then((result) => {
      if (!active) return
      dashboardResponseCache.set(requestUrl, { data: result, storedAt: Date.now() })
      setCategorySalesData(result)
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : 'Unable to load Category Wise Sales.') })
    return () => { active = false }
  }, [categorySalesChannel, globalChannel, time, activeYear, comparison, comparisonYear])

  // API data can arrive after the initial render or restore a saved channel filter.
  // Open every KPI detail panel once the dashboard is ready for viewing.
  useEffect(() => {
    if (data) setExpanded('all')
  }, [data])

  const applyFilters = () => {
    useLatestDataPeriod.current = false
    let appliedTime = draftTime.grain === 'yearly' ? { ...draftTime, period: String(draftYear) } : draftTime
    let appliedYear = draftYear
    if (dateStart) {
      const start = new Date(`${dateStart}${dateFilterMode === 'month' ? '-01' : ''}T00:00:00`)
      const endValue = dateFilterMode === 'range' && dateEnd ? dateEnd : dateStart
      const end = new Date(`${endValue}${dateFilterMode === 'month' ? '-01' : ''}T00:00:00`)
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) { setError('Choose a valid date range.'); return }
      if (start.getFullYear() !== end.getFullYear()) { setError('Custom date ranges must stay within one calendar year.'); return }
      const selectedMonths = Array.from({ length: end.getMonth() - start.getMonth() + 1 }, (_, index) => String(start.getMonth() + index + 1))
      appliedTime = { grain: 'monthly', period: selectedMonths.join(',') }
      appliedYear = start.getFullYear()
    }
    const appliedComparison = draftComparison.grain === 'yearly' ? { ...draftComparison, period: String(draftComparisonYear) } : draftComparison
    setLoading(true)
    setGlobalChannelState(draftChannel)
    setExpanded(draftChannel === 'all' ? 'all' : null)
    setTime(appliedTime)
    setActiveYear(appliedYear)
    setComparison(appliedComparison)
    setComparisonYear(draftComparisonYear)
    if (dashboardView === 'overview') {
      localStorage.setItem(DASHBOARD_FILTERS_KEY, JSON.stringify({
        channel: draftChannel, time: appliedTime, year: appliedYear,
        comparison: appliedComparison, comparisonYear: draftComparisonYear,
      }))
    }
  }

  const resetFilters = () => {
    localStorage.removeItem(DASHBOARD_FILTERS_KEY)
    useLatestDataPeriod.current = true
    setLoading(true)
    setGlobalChannelState(defaults.channel); setTime(defaults.time); setActiveYear(defaults.year)
    setComparison(defaults.comparison); setComparisonYear(defaults.comparisonYear)
    setDraftChannel(defaults.channel); setDraftTime(defaults.time); setDraftYear(defaults.year)
    setDraftComparison(defaults.comparison); setDraftComparisonYear(defaults.comparisonYear)
    setDateStart(''); setDateEnd(''); setDateFilterMode('range')
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
  const periodDisplay = (selection: TimeSelection, year: number) => selection.grain === 'monthly'
    ? selection.period.split(',').filter(Boolean).map((month) => months[Number(month) - 1]?.slice(0, 3)).filter(Boolean).join(', ') + ` ${year}`
    : selection.grain === 'quarterly'
      ? `Q${selection.period} ${year}`
      : `Full year ${year}`

  const number = (value: number) => Math.round(value).toLocaleString('en-IN')
  const variance = (actual: number, plan: number) => actual - plan
  const variancePercent = (actual: number, plan: number) => plan ? ((actual - plan) / plan) * 100 : 0
  const toggle = (id: string) => setExpanded((current) => current === id ? null : id)
  const yearOptions = data
    ? [...new Set([initialYear, initialYear - 1, ...data.available_years])].sort((a, b) => b - a)
    : [initialYear, initialYear - 1]
  const currentPlanMonths = planMonthsForGrain(time.grain, time.period)
  const comparisonPlanMonths = planMonthsForGrain(comparison.grain, comparison.period)
  const channelActual = (period: 'current' | 'comparison', channel: string) =>
    data?.channel_wise_performance[period][channel] ?? 0
  const authoritativeCurrentTotal = Math.round(channelActual('current', 'Total Sales'))
  const authoritativeComparisonTotal = Math.round(channelActual('comparison', 'Total Sales'))
  const categorySource = categoryChannel === globalChannel ? data : categoryTableData
  const categorySalesSource = categorySalesChannel === globalChannel ? data : categorySalesData
  const categorySourceCurrentTotal = Math.round(categorySource?.channel_wise_performance.current['Total Sales'] ?? 0)
  const categorySourceComparisonTotal = Math.round(categorySource?.channel_wise_performance.comparison['Total Sales'] ?? 0)
  const categoryCurrentActuals = reconciledWholeValues(
    categorySource?.category_performance.map((row) => row.current.actual) ?? [],
    categorySourceCurrentTotal,
  )
  const categoryComparisonActuals = reconciledWholeValues(
    categorySource?.category_performance.map((row) => row.comparison.actual) ?? [],
    categorySourceComparisonTotal,
  )
  const categoryPerformance = categorySource?.category_performance.map((row, index) => ({
    ...row,
    current: { ...row.current, actual: categoryCurrentActuals[index] },
    comparison: { ...row.comparison, actual: categoryComparisonActuals[index] },
  })) ?? []
  const categorySalesCurrentTotal = Math.round(categorySalesSource?.channel_wise_performance.current['Total Sales'] ?? 0)
  const categorySalesComparisonTotal = Math.round(categorySalesSource?.channel_wise_performance.comparison['Total Sales'] ?? 0)
  const categorySalesCurrentActuals = reconciledWholeValues(categorySalesSource?.category_performance.map((row) => row.current.actual) ?? [], categorySalesCurrentTotal)
  const categorySalesComparisonActuals = reconciledWholeValues(categorySalesSource?.category_performance.map((row) => row.comparison.actual) ?? [], categorySalesComparisonTotal)
  const categorySalesPerformance = categorySalesSource?.category_performance.map((row, index) => ({
    ...row,
    current: { ...row.current, actual: categorySalesCurrentActuals[index] },
    comparison: { ...row.comparison, actual: categorySalesComparisonActuals[index] },
  })) ?? []
  const categoryCurrentPlanTotal = categoryPerformance.reduce((sum, row) => sum + Math.round(row.current.plan), 0)
  const categoryComparisonPlanTotal = categoryPerformance.reduce((sum, row) => sum + Math.round(row.comparison.plan), 0)
  const categoryCurrentDifference = variance(categorySourceCurrentTotal, categoryCurrentPlanTotal)
  const categoryComparisonDifference = variance(categorySourceComparisonTotal, categoryComparisonPlanTotal)
  const categorySortValue = (row: (typeof categoryPerformance)[number], key: string) => key === 'category' ? row.category : key === 'currentPlan' ? row.current.plan : key === 'currentActual' ? row.current.actual : key === 'currentVariance' ? variance(row.current.actual, row.current.plan) : key === 'currentVariancePercent' ? variancePercent(row.current.actual, row.current.plan) : key === 'comparisonPlan' ? row.comparison.plan : key === 'comparisonActual' ? row.comparison.actual : key === 'comparisonVariance' ? variance(row.comparison.actual, row.comparison.plan) : variancePercent(row.comparison.actual, row.comparison.plan)
  const sortedCategoryPerformance = [...categoryPerformance].sort((left, right) => {
    const a = categorySortValue(left, categorySort.key); const b = categorySortValue(right, categorySort.key)
    const order = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : Number(a) - Number(b)
    return categorySort.direction === 'asc' ? order : -order
  })
  const toggleCategorySort = (key: string) => setCategorySort((current) => ({ key, direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc' }))
  const varianceHeatClass = (value: number) => `variance-heat ${value > 100 ? 'over-100' : value >= 0 ? 'above' : value >= -25 ? 'miss-25' : value >= -50 ? 'miss-50' : value >= -75 ? 'miss-75' : 'miss-100'}`
  const currentPerformancePlan = (channel: string, fallback: number) => data?.monthly_plans?.[channel] ?? (activeYear === 2026 ? fallback : 0)
  const comparisonPerformancePlan = (channel: string, fallback: number) => data?.comparison_monthly_plans?.[channel] ?? (comparisonYear === 2026 ? fallback : 0)
  const coreChannels = [
    { channel: 'Digital Online', currentMonthlyPlan: currentPerformancePlan('Digital Online', CHANNEL_MONTHLY_PLANS.digitalOnline), comparisonMonthlyPlan: comparisonPerformancePlan('Digital Online', CHANNEL_MONTHLY_PLANS.digitalOnline) },
    { channel: 'In Office', currentMonthlyPlan: currentPerformancePlan('In Office', CHANNEL_MONTHLY_PLANS.inOffice), comparisonMonthlyPlan: comparisonPerformancePlan('In Office', CHANNEL_MONTHLY_PLANS.inOffice) },
    { channel: 'Stall', currentMonthlyPlan: currentPerformancePlan('Stall', CHANNEL_MONTHLY_PLANS.stall), comparisonMonthlyPlan: comparisonPerformancePlan('Stall', CHANNEL_MONTHLY_PLANS.stall) },
    { channel: 'Bulk', currentMonthlyPlan: currentPerformancePlan('Bulk', CHANNEL_MONTHLY_PLANS.bulk), comparisonMonthlyPlan: comparisonPerformancePlan('Bulk', CHANNEL_MONTHLY_PLANS.bulk) },
    { channel: 'Call', currentMonthlyPlan: currentPerformancePlan('Call', CHANNEL_MONTHLY_PLANS.call), comparisonMonthlyPlan: comparisonPerformancePlan('Call', CHANNEL_MONTHLY_PLANS.call) },
    { channel: 'Retail', currentMonthlyPlan: currentPerformancePlan('Retail', CHANNEL_MONTHLY_PLANS.retail), comparisonMonthlyPlan: comparisonPerformancePlan('Retail', CHANNEL_MONTHLY_PLANS.retail) },
    { channel: 'Course Promotion', currentMonthlyPlan: currentPerformancePlan('Course Promotion', CHANNEL_MONTHLY_PLANS.coursePromotion), comparisonMonthlyPlan: comparisonPerformancePlan('Course Promotion', CHANNEL_MONTHLY_PLANS.coursePromotion) },
  ]
  const reconciledChannelActuals = (period: 'current' | 'comparison', total: number) => {
    const directNames = ['In Office', 'Stall', 'Bulk', 'Call', 'Retail', 'Course Promotion']
    const directRaw = directNames.map((channel) => channelActual(period, channel))
    let directActuals = reconciledWholeValues(
      directRaw,
      Math.round(directRaw.reduce((sum, value) => sum + value, 0)),
    )
    const digitalRaw = channelActual(period, 'Digital Online')
    let digitalActual = Math.round(digitalRaw)
    const difference = total - digitalActual - directActuals.reduce((sum, value) => sum + value, 0)
    if (difference && digitalRaw !== 0) digitalActual += difference
    else if (difference) directActuals = reconciledWholeValues(directRaw, directActuals.reduce((sum, value) => sum + value, 0) + difference)
    return [digitalActual, ...directActuals]
  }
  const currentChannelActuals = reconciledChannelActuals('current', authoritativeCurrentTotal)
  const comparisonChannelActuals = reconciledChannelActuals('comparison', authoritativeComparisonTotal)
  const currentActiveMonthlyPlan = coreChannels.reduce((sum, row) => sum + row.currentMonthlyPlan, 0)
  const comparisonActiveMonthlyPlan = coreChannels.reduce((sum, row) => sum + row.comparisonMonthlyPlan, 0)
  const currentLanguageLabPlan = currentPerformancePlan('Language Lab', CHANNEL_MONTHLY_PLANS.languageLab)
  const comparisonLanguageLabPlan = comparisonPerformancePlan('Language Lab', CHANNEL_MONTHLY_PLANS.languageLab)
  const currentOttPlan = currentPerformancePlan('OTT', CHANNEL_MONTHLY_PLANS.ott)
  const comparisonOttPlan = comparisonPerformancePlan('OTT', CHANNEL_MONTHLY_PLANS.ott)
  const channelPerformance = [
    ...coreChannels.map((row, index) => ({ ...row, currentActual: currentChannelActuals[index], comparisonActual: comparisonChannelActuals[index] })),
    { channel: 'Total Sales', currentMonthlyPlan: currentActiveMonthlyPlan, comparisonMonthlyPlan: comparisonActiveMonthlyPlan, currentActual: authoritativeCurrentTotal, comparisonActual: authoritativeComparisonTotal },
    { channel: 'Language Lab', currentMonthlyPlan: currentLanguageLabPlan, comparisonMonthlyPlan: comparisonLanguageLabPlan, currentActual: channelActual('current', 'Language Lab'), comparisonActual: channelActual('comparison', 'Language Lab') },
    { channel: 'OTT', currentMonthlyPlan: currentOttPlan, comparisonMonthlyPlan: comparisonOttPlan, currentActual: channelActual('current', 'OTT'), comparisonActual: channelActual('comparison', 'OTT') },
    { channel: 'Grand Total Sales', currentMonthlyPlan: currentActiveMonthlyPlan + currentLanguageLabPlan + currentOttPlan, comparisonMonthlyPlan: comparisonActiveMonthlyPlan + comparisonLanguageLabPlan + comparisonOttPlan, currentActual: Math.round(channelActual('current', 'Grand Total Sales')), comparisonActual: Math.round(channelActual('comparison', 'Grand Total Sales')) },
  ]
  const grandTotalPerformance = channelPerformance[channelPerformance.length - 1]
  const channelCurrentPlanTotal = grandTotalPerformance.currentMonthlyPlan * currentPlanMonths
  const channelComparisonPlanTotal = grandTotalPerformance.comparisonMonthlyPlan * comparisonPlanMonths
  const channelCurrentActualTotal = grandTotalPerformance.currentActual
  const channelComparisonActualTotal = grandTotalPerformance.comparisonActual
  const channelVarianceClass = (value: number) => `channel-variance-percent ${value > 100 ? 'over-100' : value >= 0 ? 'above' : value >= -25 ? 'miss-25' : value >= -50 ? 'miss-50' : value >= -75 ? 'miss-75' : 'miss-100'}`
  const channelCellProps = (key: string, className = '') => ({
    className: `${className}${selectedChannelCell === key ? ' is-selected' : ''}`.trim(),
    tabIndex: 0,
    'aria-selected': selectedChannelCell === key,
    onClick: () => setSelectedChannelCell(key),
    onFocus: () => setSelectedChannelCell(key),
  })

  const activeCurrentSum = currentChannelActuals.reduce((sum, value) => sum + value, 0)
  const activeComparisonSum = comparisonChannelActuals.reduce((sum, value) => sum + value, 0)
  const subtotalPlan = currentActiveMonthlyPlan
  const inactivePlan = currentLanguageLabPlan + currentOttPlan
  useEffect(() => {
    if (activeCurrentSum !== authoritativeCurrentTotal) console.warn(`Channel performance mismatch: current subtotal is ${authoritativeCurrentTotal}, expected ${activeCurrentSum}.`)
    if (activeComparisonSum !== authoritativeComparisonTotal) console.warn(`Channel performance mismatch: comparison subtotal is ${authoritativeComparisonTotal}, expected ${activeComparisonSum}.`)
    if (subtotalPlan + inactivePlan !== grandTotalPerformance.currentMonthlyPlan) console.warn('Channel performance mismatch: grand total plan does not equal subtotal plan plus no-activity plans.')
  }, [activeCurrentSum, activeComparisonSum, authoritativeCurrentTotal, authoritativeComparisonTotal, subtotalPlan, inactivePlan])
  const performanceHeaders = [
    'Name',
    'Current Plan', 'Current Actual', 'Current Variance', 'Current Variance %',
    'Comparison Plan', 'Comparison Actual', 'Comparison Variance', 'Comparison Variance %',
  ]
  const downloadCategoryPerformance = () => {
    if (!data) return
    const rows = [...categoryPerformance, {
      category: 'Total',
      current: {
        plan: categoryPerformance.reduce((sum, row) => sum + Math.round(row.current.plan), 0),
        actual: authoritativeCurrentTotal,
      },
      comparison: {
        plan: categoryPerformance.reduce((sum, row) => sum + Math.round(row.comparison.plan), 0),
        actual: authoritativeComparisonTotal,
      },
    }]
    downloadCsv(
      `category-wise-performance-${globalChannel}-${time.grain}-${time.period}.csv`,
      performanceHeaders,
      rows.map((row) => [
        row.category,
        number(row.current.plan), number(row.current.actual), number(variance(row.current.actual, row.current.plan)), reportPercentage(variancePercent(row.current.actual, row.current.plan)),
        number(row.comparison.plan), number(row.comparison.actual), number(variance(row.comparison.actual, row.comparison.plan)), reportPercentage(variancePercent(row.comparison.actual, row.comparison.plan)),
      ]),
    )
  }
  const downloadChannelPerformance = () => downloadCsv(
    `channel-wise-performance-${globalChannel}-${time.grain}-${time.period}.csv`,
    performanceHeaders,
    channelPerformance.map((row) => {
      const currentPlan = row.currentMonthlyPlan * currentPlanMonths
      const comparisonPlan = row.comparisonMonthlyPlan * comparisonPlanMonths
      return [
        row.channel,
        number(currentPlan), number(row.currentActual), number(variance(row.currentActual, currentPlan)), reportPercentage(variancePercent(row.currentActual, currentPlan)),
        number(comparisonPlan), number(row.comparisonActual), number(variance(row.comparisonActual, comparisonPlan)), reportPercentage(variancePercent(row.comparisonActual, comparisonPlan)),
      ]
    }),
  )
  const clearVisualDateRange = () => {
    const restoredTime = draftTime.grain === 'yearly' ? { ...draftTime, period: String(draftYear) } : draftTime
    useLatestDataPeriod.current = false
    setDateStart('')
    setDateEnd('')
    setLoading(true)
    setTime(restoredTime)
    setActiveYear(draftYear)
    localStorage.setItem(DASHBOARD_FILTERS_KEY, JSON.stringify({
      channel: globalChannel,
      time: restoredTime,
      year: draftYear,
      comparison,
      comparisonYear,
    }))
  }
  const renderDateRangeFilter = () => <div className="visual-date-filter-row"><div className="dashboard-date-filter">
    <span className="filter-label"><Icon name="calendar" size={14} /> Date range</span>
    <label><span>Type</span><select value={dateFilterMode} onChange={(event) => { setDateFilterMode(event.target.value as typeof dateFilterMode); setDateStart(''); setDateEnd('') }}><option value="date">Specific date</option><option value="month">Month</option><option value="range">Custom range</option></select></label>
    <label><span>{dateFilterMode === 'range' ? 'From' : dateFilterMode === 'month' ? 'Month' : 'Date'}</span><input type={dateFilterMode === 'month' ? 'month' : 'date'} value={dateStart} onChange={(event) => setDateStart(event.target.value)} /></label>
    {dateFilterMode === 'range' && <label><span>To</span><input type="date" min={dateStart || undefined} value={dateEnd} onChange={(event) => setDateEnd(event.target.value)} /></label>}
    <div className="date-filter-actions"><button className="date-clear-button" type="button" disabled={!dateStart && !dateEnd} onClick={clearVisualDateRange}>Clear</button><button className="date-apply-button" type="button" disabled={!dateStart} onClick={applyFilters}>Apply</button></div>
  </div></div>
  const setGlobalChannel = (channel: string) => {
    setLoading(true)
    setGlobalChannelState(channel)
    setDraftChannel(channel)
    setExpanded(channel === 'all' ? 'all' : null)
    setPageFilters((current) => ({
      ...current,
      product: { ...current.product, channel: null },
      state: { ...current.state, channel: null },
      customer: { ...current.customer, channel: null },
      financial: { ...current.financial, channel: null },
    }))
    setCategoryChannel(channel)
    setCategorySalesChannel(channel)
    const overview = overviewFilters.current
    localStorage.setItem(DASHBOARD_FILTERS_KEY, JSON.stringify({
      channel,
      time: overview?.time ?? time,
      year: overview?.year ?? activeYear,
      comparison: overview?.comparison ?? comparison,
      comparisonYear: overview?.comparisonYear ?? comparisonYear,
    }))
  }
  const categoryTableLoading = false
  const setPageChannel = (view: Exclude<DashboardView, 'overview'>, channel: string) => {
    setDetailLoading(true)
    setPageFilters((current) => ({ ...current, [view]: { ...current[view], channel } }))
  }
  const setCustomerPageChannel = (channel: string) => {
    if (channel === 'amazon') {
      window.alert('No customer performance details available for Amazon.')
      return
    }
    setPageChannel('customer', channel)
  }
  const renderPageChannelFilter = (view: Exclude<DashboardView, 'overview'>) => <label><span>Channel</span><select value={pageFilters[view].channel ?? globalChannel} onChange={(event) => setPageChannel(view, event.target.value)}>{DASHBOARD_CHANNEL_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
  const renderStateFilters = () => <div className="state-visual-filters"><div className="product-detail-controls">{renderPageChannelFilter('state')}</div>{renderDateRangeFilter()}</div>
  const renderPerformanceSummary = (currentTotal: number, currentDifference: number, comparisonTotal: number, comparisonDifference: number) => <div className="performance-summary" aria-label="Performance totals and differences">
    <div className="summary-period"><span>Current period</span><div><small>Total actual</small><strong>{number(currentTotal)}</strong></div><div><small>Difference</small><strong className={currentDifference >= 0 ? 'positive' : 'negative'}>{currentDifference >= 0 ? '+' : '−'}{number(Math.abs(currentDifference))}</strong></div></div>
    <div className="summary-period is-comparison"><span>Comparison period</span><div><small>Total actual</small><strong>{number(comparisonTotal)}</strong></div><div><small>Difference</small><strong className={comparisonDifference >= 0 ? 'positive' : 'negative'}>{comparisonDifference >= 0 ? '+' : '−'}{number(Math.abs(comparisonDifference))}</strong></div></div>
  </div>

  const openDashboardView = (view: Exclude<DashboardView, 'overview'>) => {
    if (view === 'customer' && globalChannel === 'amazon') {
      window.alert('No customer performance details available for Amazon.')
      return
    }
    setDetailLoading(true)
    overviewFilters.current = {
      channel: globalChannel,
      time: { ...time },
      year: activeYear,
      comparison: { ...comparison },
      comparisonYear,
    }
    setDashboardView(view)
  }

  const backToDashboard = () => {
    const leavingView = dashboardView
    const saved = overviewFilters.current
    if (saved) {
      setLoading(true)
      setTime(saved.time)
      setActiveYear(saved.year)
      setComparison(saved.comparison)
      setComparisonYear(saved.comparisonYear)
      setDraftChannel(globalChannel)
      setDraftTime(saved.time)
      setDraftYear(saved.year)
      setDraftComparison(saved.comparison)
      setDraftComparisonYear(saved.comparisonYear)
      localStorage.setItem(DASHBOARD_FILTERS_KEY, JSON.stringify({
        channel: globalChannel,
        time: saved.time,
        year: saved.year,
        comparison: saved.comparison,
        comparisonYear: saved.comparisonYear,
      }))
      overviewFilters.current = null
    }
    if (leavingView !== 'overview') {
      setPageFilters((current) => ({
        ...current,
        [leavingView]: { channel: null, dateFilterMode: 'range', dateStart: '', dateEnd: '' },
      }))
      setCategoryChannel(globalChannel)
      setCategorySalesChannel(globalChannel)
    }
    setDashboardView('overview')
  }

  const storedDetailData = detailView ? detailData[detailView] : undefined
  const pageData = detailView
    ? storedDetailData?.selected_channel === effectiveChannel ? storedDetailData : null
    : data
  if ((detailView || loading || detailLoading) && !pageData) return <div className="content"><div className="dashboard-loading">Calculating reviewed sales KPIs…</div></div>
  if (pageData && dashboardView !== 'overview') {
    const pageTitle = dashboardView === 'product' ? 'Product performance' : dashboardView === 'state' ? 'State performance' : dashboardView === 'customer' ? 'Customer performance' : 'Financial breakdown'
    return <div className="content dashboard-page dashboard-subpage">
      <section className="dashboard-subpage-head"><button type="button" onClick={backToDashboard}>← Back to dashboard</button><div><span className="section-kicker">Performance detail</span><h2>{pageTitle}</h2><p>This page inherits the global filter; changes made here stay on this page.</p></div></section>
      {error && <div className="error-message dashboard-error"><Icon name="info" size={18} /><span>{error}</span></div>}
      <div className="dashboard-subpage-content">
        {dashboardView === 'product' && <ProductRankings data={pageData.product_performance} loading={detailLoading} channel={effectiveChannel} onChannelChange={(channel) => setPageChannel('product', channel)} dateFilter={renderDateRangeFilter()} />}
        {dashboardView === 'state' && <StateWisePerformance rows={pageData.state_performance} orderDetails={pageData.state_order_details ?? []} loading={detailLoading} filters={renderStateFilters()} />}
        {dashboardView === 'customer' && <CustomersByEmail data={pageData.customer_performance} loading={detailLoading} period={periodDisplay(time, activeYear)} orderDetails={pageData.state_order_details ?? []} channel={effectiveChannel} onChannelChange={setCustomerPageChannel} dateFilter={renderDateRangeFilter()} />}
        {dashboardView === 'financial' && <FinancialBreakdown data={pageData.financial_breakdown} loading={detailLoading} channel={effectiveChannel} onChannelChange={(channel) => setPageChannel('financial', channel)} dateFilter={renderDateRangeFilter()} />}
      </div>
    </div>
  }
  if (!data) return <div className="content"><div className="dashboard-loading">No dashboard data is available.</div></div>
  const salesPlanChannels = {
    DSG: data.monthly_plans?.DSG ?? (activeYear === 2026 ? DEFAULT_2026_SALES_PLANS.DSG : 0),
    SFH: data.monthly_plans?.SFH ?? (activeYear === 2026 ? DEFAULT_2026_SALES_PLANS.SFH : 0),
    Amazon: data.monthly_plans?.Amazon ?? (activeYear === 2026 ? DEFAULT_2026_SALES_PLANS.Amazon : 0),
    'Direct Sales': data.monthly_plans?.['Direct Sales'] ?? (activeYear === 2026 ? DEFAULT_2026_SALES_PLANS['Direct Sales'] : 0),
  }
  const performanceCoreMonthlyPlan = ['Digital Online', 'In Office', 'Stall', 'Bulk', 'Call', 'Retail', 'Course Promotion']
    .reduce((sum, channel) => sum + (data.monthly_plans?.[channel] ?? 0), 0)
  const selectedPlanChannel = globalChannel === 'dsg' ? 'DSG' : globalChannel === 'sfh' ? 'SFH' : globalChannel === 'amazon' ? 'Amazon' : globalChannel === 'direct' ? 'Direct Sales' : null
  const selectedMonthlyPlan = selectedPlanChannel
    ? salesPlanChannels[selectedPlanChannel]
    : performanceCoreMonthlyPlan || Object.values(salesPlanChannels).reduce((sum, value) => sum + value, 0)

  return (
    <div className="content dashboard-page">
      <section className="intro"><div><span className="section-kicker">Reviewed sales data</span><h2>Sales KPI Dashboard</h2><p>Consolidated performance with channel filtering, category breakdowns, and monthly trends.</p></div></section>
      {error && <div className="error-message dashboard-error"><Icon name="info" size={18} /><span>{error}</span></div>}
      {data && <>
        <div className="comparison-panel">
          <div className="comparison-panel-head"><div><span className="filter-label">Dashboard comparison</span><h3>Compare sales periods</h3></div><div className="filter-actions"><button className="reset-filter-button" onClick={resetFilters}>Reset</button><button className="apply-filter-button" onClick={applyFilters}>Apply</button></div></div>
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
            <select className={`all-channels-select ${globalChannel === 'all' ? 'active' : ''}`} aria-label="All Channels" value={globalChannel} onChange={(event) => setGlobalChannel(event.target.value)}>{DASHBOARD_CHANNEL_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>
            <button className="product-performance-button" type="button" onClick={() => openDashboardView('product')}>Product performance <span aria-hidden="true">→</span></button>
            <button type="button" onClick={() => openDashboardView('state')}>State performance</button>
            <button type="button" onClick={() => openDashboardView('customer')}>Customer performance</button>
            <button type="button" onClick={() => openDashboardView('financial')}>Financial breakdown</button>
          </div></div>
        </div>
        <div className="dashboard-filter-groups">
          <div className="filter-group">
            <span className="filter-label">Channel</span>
            <div className="dashboard-filters">
              {DASHBOARD_CHANNEL_OPTIONS.map((filter) => <button className={globalChannel === filter.value ? 'active' : ''} key={filter.value} onClick={() => setGlobalChannel(filter.value)}>{filter.label}</button>)}
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
        <section className={`kpi-grid ${globalChannel !== 'all' ? 'channel-view' : ''} ${loading ? 'is-loading' : ''}`}>
          {data.cards.map((card) => {
            const isExpanded = expanded === 'all' || expanded === card.id
            const trend = trendDetails(card.trend)
            const isAllChannelsPnl = globalChannel === 'all' && card.id === 'pnl'
            const isAllChannelsTaxCard = globalChannel === 'all' && ['zero_rated', 'exempted', 'taxable'].includes(card.id)
            const isOrderCountCard = card.id === 'orders'
            const comparison = periodComparison(card)
            const plan = getPlanForGrain(selectedMonthlyPlan, time.grain, time.period)
            const achievement = plan > 0 ? Math.round((card.total / plan) * 100) : 0
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
            if (globalChannel !== 'all') {
              const channelName = globalChannel === 'dsg' ? 'DSG' : globalChannel === 'sfh' ? 'SFH' : globalChannel === 'amazon' ? 'Amazon' : 'Direct Sales'
              const maximumCategory = Math.max(...displayBreakdown.map((item) => item.value), 1)
              const categoryTone = (label: string) => label.includes('Books') ? 'orange' : label.includes('Audio') ? 'teal' : label.includes('Pen') ? 'pink' : 'violet'
              const cardIcon = card.id === 'zero_rated' ? '⊙' : card.id === 'exempted' ? '▧' : card.id === 'taxable' ? '▦' : '▣'
              return <article className={`kpi-card channel-kpi-card ${isExpanded ? 'is-expanded' : ''}`} key={card.id}>
                <button className="channel-kpi-head kpi-card-head" onClick={() => toggle(card.id)} aria-expanded={isExpanded}>
                  <span><i>{cardIcon}</i>{card.title}</span>
                  <span className={`kpi-chevron ${isExpanded ? 'open' : ''}`}>⌃</span>
                </button>
                <strong className="kpi-value">{number(card.total)}</strong>
                <p>{card.subtitle}, {channelName}</p>
                <div className={`kpi-details ${isExpanded ? 'is-open' : ''}`}><div className="channel-category-breakdown">
                  {displayBreakdown.length ? displayBreakdown.map((item) => {
                    const tone = categoryTone(item.label)
                    return <div className="channel-category-row" key={item.label}>
                      <div><span><i className={tone} />{item.label}</span><strong>{number(item.value)}</strong></div>
                      <div className="category-bar"><span className={tone} style={{ width: `${Math.max((item.value / maximumCategory) * 100, item.value ? 7 : 0)}%` }} /></div>
                    </div>
                  }) : <div className="channel-empty-row">No applicable sales</div>}
                </div>
                <div className="channel-kpi-total"><span>Total</span><strong>{number(card.total)}</strong></div>
                </div>
              </article>
            }
            if (isAllChannelsPnl) {
              return <article className={`kpi-card ${isExpanded ? 'is-expanded' : ''}`} key={card.id}>
                <button className="kpi-card-head" onClick={() => toggle(card.id)} aria-expanded={isExpanded}>
                  <span>{card.title}</span>
                  <span className="kpi-head-actions">
                    <span className={`plan-badge ${achievementTone}`}>{achievement}% of plan</span>
                    <span className={`kpi-chevron ${isExpanded ? 'open' : ''}`}>⌃</span>
                  </span>
                </button>
                <div className="kpi-value-row comparison-value-row">
                  <strong className="kpi-value">{number(card.total)} <span className="plan-value">/ {number(plan)}</span></strong>
                  <span className={`delta-badge comparison-badge ${comparison.direction}`}>
                    <span className="delta-arrow">{comparison.direction === 'up' ? '↑' : comparison.direction === 'down' ? '↓' : '—'}</span>
                    {comparison.label}
                  </span>
                </div>
                <p>{card.subtitle}</p>
                <div className="plan-progress" role="progressbar" aria-label="Sales plan achievement" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(Math.max(achievement, 0), 100)}>
                  <span className={achievementTone} style={{ width: `${Math.min(Math.max(achievement, 0), 100)}%` }} />
                </div>
                <div className={`kpi-details ${isExpanded ? 'is-open' : ''}`}><div className="kpi-breakdown">
                  {displayBreakdown.length ? displayBreakdown.map((item) => <div key={item.label}><span>{item.label}</span><strong>{number(item.value)}</strong></div>) : <div className="no-breakdown"><span>No applicable sales</span><strong>0</strong></div>}
                  <div className="kpi-total"><span>Total</span><strong>{number(card.total)}</strong></div>
                </div></div>
              </article>
            }
            if (isOrderCountCard) {
              return <article className={`kpi-card ${isExpanded ? 'is-expanded' : ''}`} key={card.id}>
                <button className="kpi-card-head" onClick={() => toggle(card.id)} aria-expanded={isExpanded}>
                  <span>{card.title}</span><span className={`kpi-chevron ${isExpanded ? 'open' : ''}`}>⌃</span>
                </button>
                <div className="kpi-value-row comparison-value-row">
                  <strong className="kpi-value">{number(card.total)}</strong>
                  <span className={`delta-badge comparison-badge ${comparison.direction}`}>
                    <span className="delta-arrow">{comparison.direction === 'up' ? '↑' : comparison.direction === 'down' ? '↓' : '—'}</span>
                    {comparison.label}
                  </span>
                </div>
                <p>{card.subtitle}</p>
                <div className={`kpi-details ${isExpanded ? 'is-open' : ''}`}><div className="kpi-breakdown">
                  {displayBreakdown.map((item) => <div key={item.label}><span>{item.label}</span><strong>{number(item.value)}</strong></div>)}
                  <div className="kpi-total"><span>Total</span><strong>{number(card.total)}</strong></div>
                </div></div>
              </article>
            }
            if (isAllChannelsTaxCard) {
              return <article className={`kpi-card ${isExpanded ? 'is-expanded' : ''}`} key={card.id}>
                <button className="kpi-card-head" onClick={() => toggle(card.id)} aria-expanded={isExpanded}>
                  <span>{card.title}</span><span className={`kpi-chevron ${isExpanded ? 'open' : ''}`}>⌃</span>
                </button>
                <div className="kpi-value-row comparison-value-row">
                  <strong className="kpi-value">{number(card.total)}</strong>
                  <span className={`delta-badge comparison-badge ${comparison.direction}`}>
                    <span className="delta-arrow">{comparison.direction === 'up' ? '↑' : comparison.direction === 'down' ? '↓' : '—'}</span>
                    {comparison.label}
                  </span>
                </div>
                <p>{card.subtitle}</p>
                <div className={`kpi-details ${isExpanded ? 'is-open' : ''}`}><div className="kpi-breakdown">
                  {displayBreakdown.length ? displayBreakdown.map((item) => <div key={item.label}><span>{item.label}</span><strong>{number(item.value)}</strong></div>) : <div className="no-breakdown"><span>No applicable sales</span><strong>0</strong></div>}
                  <div className="kpi-total"><span>Total</span><strong>{number(card.total)}</strong></div>
                </div></div>
              </article>
            }
            return <article className={`kpi-card ${isExpanded ? 'is-expanded' : ''}`} key={card.id}>
              <button className="kpi-card-head" onClick={() => toggle(card.id)} aria-expanded={isExpanded}>
                <span>{card.title}</span><span className={`kpi-chevron ${isExpanded ? 'open' : ''}`}>⌃</span>
              </button>
              <div className="kpi-value-row"><strong className="kpi-value">{number(card.total)}</strong>{card.trend.length >= 2 && <span className={`delta-badge ${trend.direction}`}><span className="delta-arrow">{trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : ''}</span>{trend.label}</span>}</div>
              <p>{card.subtitle}</p>
              {card.trend.length >= 2 ? <Sparkline values={card.trend} direction={trend.direction} /> : <div className="trend-insufficient">Not enough data at this grain yet</div>}
              <div className={`kpi-details ${isExpanded ? 'is-open' : ''}`}><div className="kpi-breakdown">
                {displayBreakdown.length ? displayBreakdown.map((item) => <div key={item.label}><span>{item.label}</span><strong>{number(item.value)}</strong></div>) : <div className="no-breakdown"><span>No applicable sales</span><strong>0</strong></div>}
                <div className="kpi-total"><span>Total</span><strong>{number(card.total)}</strong></div>
              </div></div>
            </article>
          })}
        </section>
        <SalesTrendChart key={`sales-trend-${globalChannel}`} trend={data.sales_trend} loading={loading} monthlyPlans={salesPlanChannels} allMonthlyPlan={performanceCoreMonthlyPlan || undefined} initialChannel={globalChannel === 'dsg' ? 'DSG' : globalChannel === 'sfh' ? 'SFH' : globalChannel === 'amazon' ? 'Amazon' : globalChannel === 'direct' ? 'Direct Sales' : 'all'} />
        <div className="dashboard-visual-grid">
        <section className={`category-performance category-only-performance ${loading || categoryTableLoading ? 'is-loading' : ''}`}>
          <div className="category-performance-head">
            <div><span className="section-kicker">Sales mix analysis</span><h3>Category Wise Performance</h3><p>{categoryChannel === 'all' ? 'All channels' : categoryChannel === 'dsg' ? 'DSG' : categoryChannel === 'sfh' ? 'SFH' : categoryChannel === 'amazon' ? 'Amazon' : 'Direct Sales'} · {periodDisplay(time, activeYear)} compared with {periodDisplay(comparison, comparisonYear)}</p></div>
            <div className="category-performance-actions"><label><span>Channel</span><select value={categoryChannel} onChange={(event) => setCategoryChannel(event.target.value)}>{DASHBOARD_CHANNEL_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label><span>Period</span><select value={categoryPeriodView} onChange={(event) => setCategoryPeriodView(event.target.value as typeof categoryPeriodView)}><option value="both">Both periods</option><option value="current">Current only</option><option value="comparison">Comparison only</option></select></label><label><span>Sort</span><select value={`${categorySort.key}:${categorySort.direction}`} onChange={(event) => { const [key, direction] = event.target.value.split(':'); setCategorySort({ key, direction: direction as 'asc' | 'desc' }) }}><option value="category:asc">Category A-Z</option><option value="category:desc">Category Z-A</option><option value="currentVariancePercent:asc">Worst variance first</option><option value="currentVariancePercent:desc">Best variance first</option><option value="currentActual:desc">Actual high-low</option><option value="currentActual:asc">Actual low-high</option></select></label><button className="table-download-button" type="button" onClick={downloadCategoryPerformance}>↓ Download CSV</button></div>
          </div>
          {renderDateRangeFilter()}
          {renderPerformanceSummary(categorySourceCurrentTotal, categoryCurrentDifference, categorySourceComparisonTotal, categoryComparisonDifference)}
          <div className="category-performance-scroll">
            <table className="category-performance-table" aria-label="Category wise sales performance against plan">
              <caption>Category wise sales performance against plan</caption>
              <colgroup><col className="category-column" />{Array.from({ length: categoryPeriodView === 'both' ? 8 : 4 }, (_, index) => <col className="metric-column" key={index} />)}</colgroup>
              <thead>
                <tr><th rowSpan={2}><button className="sortable-heading" onClick={() => toggleCategorySort('category')}>Category {categorySort.key === 'category' ? categorySort.direction === 'asc' ? '↑' : '↓' : '↕'}</button></th>{categoryPeriodView !== 'comparison' && <th colSpan={4}>Current Period</th>}{categoryPeriodView !== 'current' && <th className="period-group-start" colSpan={4}>Comparison Period</th>}</tr>
                <tr>{categoryPeriodView !== 'comparison' && <>{[['currentPlan','Plan'],['currentActual','Actual'],['currentVariance','Difference'],['currentVariancePercent','Diff. %']].map(([key,label]) => <th className={`${key.includes('Variance') ? 'difference-heading ' : ''}${key.endsWith('Percent') ? 'variance-percent-heading' : ''}`} key={key}><button className="sortable-heading" onClick={() => toggleCategorySort(key)}>{label} {categorySort.key === key ? categorySort.direction === 'asc' ? '↑' : '↓' : '↕'}</button></th>)}</>}{categoryPeriodView !== 'current' && <>{[['comparisonPlan','Plan'],['comparisonActual','Actual'],['comparisonVariance','Difference'],['comparisonVariancePercent','Diff. %']].map(([key,label], index) => <th className={`${index === 0 ? 'period-group-start ' : ''}${key.includes('Variance') ? 'difference-heading ' : ''}${key.endsWith('Percent') ? 'variance-percent-heading' : ''}`} key={key}><button className="sortable-heading" onClick={() => toggleCategorySort(key)}>{label} {categorySort.key === key ? categorySort.direction === 'asc' ? '↑' : '↓' : '↕'}</button></th>)}</>}</tr>
              </thead>
              <tbody>
                {[...sortedCategoryPerformance, {
                  category: 'Total',
                  current: {
                    plan: categoryCurrentPlanTotal,
                    actual: categorySourceCurrentTotal,
                  },
                  comparison: {
                    plan: categoryComparisonPlanTotal,
                    actual: categorySourceComparisonTotal,
                  },
                }].map((row) => {
                  const currentVariance = variance(row.current.actual, row.current.plan)
                  const comparisonVariance = variance(row.comparison.actual, row.comparison.plan)
                  return <tr className={row.category === 'Total' ? 'performance-total' : ''} key={row.category}>
                    <th>{row.category}</th>
                    {categoryPeriodView !== 'comparison' && <><td className="reference-value">{number(row.current.plan)}</td><td className="important-value">{number(row.current.actual)}</td>
                    <td className={currentVariance >= 0 ? 'positive' : 'negative'}>{currentVariance >= 0 ? '+' : '−'}{number(Math.abs(currentVariance))}</td>
                    <td className={varianceHeatClass(variancePercent(row.current.actual, row.current.plan))}>{variancePercent(row.current.actual, row.current.plan) > 0 ? '+' : ''}{Math.round(variancePercent(row.current.actual, row.current.plan))}%</td></>}
                    {categoryPeriodView !== 'current' && <><td className="period-group-start reference-value">{number(row.comparison.plan)}</td><td className="important-value comparison-value">{number(row.comparison.actual)}</td>
                    <td className={comparisonVariance >= 0 ? 'positive' : 'negative'}>{comparisonVariance >= 0 ? '+' : '−'}{number(Math.abs(comparisonVariance))}</td>
                    <td className={varianceHeatClass(variancePercent(row.comparison.actual, row.comparison.plan))}>{variancePercent(row.comparison.actual, row.comparison.plan) > 0 ? '+' : ''}{Math.round(variancePercent(row.comparison.actual, row.comparison.plan))}%</td></>}
                  </tr>
                })}
              </tbody>
            </table>
          </div>
          <div className="variance-legend" aria-label="Variance percentage against plan legend"><span className="variance-legend-caption">Variance % against plan</span><div className="variance-legend-cluster"><b>Positive</b><div><i className="over-100" /><span>Over +100%</span></div><div><i className="above" /><span>Above plan</span></div></div><div className="variance-legend-scale">{[['miss-25', '0 to -25%'], ['miss-50', '-50%'], ['miss-75', '-75%'], ['miss-100', '-100%']].map(([tone, label]) => <div key={tone}><i className={tone} /><span>{label}</span></div>)}</div></div>
        </section>
        <section className={`category-performance channel-performance ${loading ? 'is-loading' : ''}`}>
          <div className="category-performance-head">
            <div><span className="section-kicker">Channel analysis</span><h3>Channel wise performance</h3><p>{periodDisplay(time, activeYear)} compared with {periodDisplay(comparison, comparisonYear)}</p></div>
            <div className="category-performance-actions"><label><span>Period</span><select value={channelPeriodView} onChange={(event) => setChannelPeriodView(event.target.value as typeof channelPeriodView)}><option value="both">Both periods</option><option value="current">Current only</option><option value="comparison">Comparison only</option></select></label><button className="table-download-button" type="button" onClick={downloadChannelPerformance}>↓ Download CSV</button></div>
          </div>
          {renderDateRangeFilter()}
          {renderPerformanceSummary(channelCurrentActualTotal, variance(channelCurrentActualTotal, channelCurrentPlanTotal), channelComparisonActualTotal, variance(channelComparisonActualTotal, channelComparisonPlanTotal))}
          <div className="category-performance-scroll">
            <table className="category-performance-table" aria-label="Channel wise sales performance against plan">
              <caption>Channel wise sales performance against plan</caption>
              <colgroup><col className="channel-column" />{Array.from({ length: channelPeriodView === 'both' ? 8 : 4 }, (_, index) => <col className="channel-metric-column" key={index} />)}</colgroup>
              <thead>
                <tr><th rowSpan={2}>Channel</th>{channelPeriodView !== 'comparison' && <th className="current-period-heading" colSpan={4}>Current period</th>}{channelPeriodView !== 'current' && <th className="comparison-period-heading" colSpan={4}>Comparison period</th>}</tr>
                <tr>{channelPeriodView !== 'comparison' && <><th>Plan</th><th>Actual</th><th className="difference-heading">Difference</th><th className="difference-heading">Diff. %</th></>}{channelPeriodView !== 'current' && <><th className="period-group-start">Plan</th><th>Actual</th><th className="difference-heading">Difference</th><th className="difference-heading">Diff. %</th></>}</tr>
              </thead>
              <tbody>
                {channelPerformance.map((row, index) => {
                  const currentPlan = row.currentMonthlyPlan * currentPlanMonths
                  const comparisonPlan = row.comparisonMonthlyPlan * comparisonPlanMonths
                  const currentVariance = variance(row.currentActual, currentPlan)
                  const comparisonVariance = variance(row.comparisonActual, comparisonPlan)
                  const currentPercent = variancePercent(row.currentActual, currentPlan)
                  const comparisonPercent = variancePercent(row.comparisonActual, comparisonPlan)
                  const isSubtotal = row.channel === 'Total Sales'
                  const isGrandTotal = row.channel === 'Grand Total Sales'
                  const columnCount = channelPeriodView === 'both' ? 9 : 5
                  return <Fragment key={row.channel}>
                    {index === 0 && <tr className="channel-rowgroup"><th scope="rowgroup" colSpan={columnCount}>Active channels</th></tr>}
                    <tr className={isSubtotal ? 'channel-subtotal' : isGrandTotal ? 'channel-grand-total' : ''}>
                      <th scope="row">{isSubtotal ? <span className="subtotal-label"><b>Subtotal</b><span>Active channels</span></span> : row.channel}</th>
                      {channelPeriodView !== 'comparison' && <><td {...channelCellProps(`${row.channel}:current-plan`, 'plan-cell')}>{number(currentPlan)}</td><td {...channelCellProps(`${row.channel}:current-actual`, 'important-value')}>{number(row.currentActual)}</td><td {...channelCellProps(`${row.channel}:current-variance`, currentVariance >= 0 ? 'positive' : 'negative')}>{currentVariance >= 0 ? '+' : '−'}{number(Math.abs(currentVariance))}</td><td {...channelCellProps(`${row.channel}:current-percent`, isSubtotal || isGrandTotal ? `${currentVariance >= 0 ? 'positive' : 'negative'} summary-percent` : channelVarianceClass(currentPercent))}>{currentPercent >= 0 ? '+' : '−'}{Math.abs(Math.round(currentPercent))}%</td></>}
                      {channelPeriodView !== 'current' && <><td {...channelCellProps(`${row.channel}:comparison-plan`, 'plan-cell period-group-start')}>{number(comparisonPlan)}</td><td {...channelCellProps(`${row.channel}:comparison-actual`, 'comparison-actual important-value')}>{number(row.comparisonActual)}</td><td {...channelCellProps(`${row.channel}:comparison-variance`, comparisonVariance >= 0 ? 'positive' : 'negative')}>{comparisonVariance >= 0 ? '+' : '−'}{number(Math.abs(comparisonVariance))}</td><td {...channelCellProps(`${row.channel}:comparison-percent`, isSubtotal || isGrandTotal ? `${comparisonVariance >= 0 ? 'positive' : 'negative'} summary-percent` : channelVarianceClass(comparisonPercent))}>{comparisonPercent >= 0 ? '+' : '−'}{Math.abs(Math.round(comparisonPercent))}%</td></>}
                    </tr>
                  </Fragment>
                })}
              </tbody>
            </table>
          </div>
          <div className="channel-variance-legend" aria-label="Variance percentage against plan legend"><span>Variance % against plan</span><div className="legend-cluster"><b>Positive</b><div><i className="over-100" /><small>Over +100%</small></div><div><i className="above" /><small>Above plan</small></div></div><div className="legend-cluster negative-scale"><b>Negative</b>{[['miss-25','0 to -25%'],['miss-50','-50%'],['miss-75','-75%'],['miss-100','-100%']].map(([tone,label]) => <div key={tone}><i className={tone} /><small>{label}</small></div>)}</div></div>
        </section>
        <CategoryWiseSales rows={categorySalesPerformance} loading={loading} channel={categorySalesChannel} onChannelChange={setCategorySalesChannel} dateFilter={renderDateRangeFilter()} />
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
  onDelete,
}: {
  uploadId: string
  initialRows: ReviewRow[]
  onBack: () => void
  onContinue: () => void
  channel: UploadChannel
  onDelete?: () => void
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
        <div className="review-header-actions"><div className="review-count"><strong>{rows.length}</strong><span>records remaining</span></div>{onDelete && <button className="delete-button discard-upload" type="button" onClick={onDelete}>Delete upload</button>}</div>
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
                          <option value="">Select category</option><option>Books</option><option>Web Version</option><option>Audio Device</option><option>Pen Drive</option>{channel === 'Direct Sales' && <><option>N/A</option><option>Language Lab</option></>}
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
  onPendingGroupsChange,
  channel,
  onDelete,
}: {
  uploadId: string
  initialGroups: ProductGroup[]
  onComplete: () => void
  onPendingGroupsChange: (groups: ProductGroup[]) => void
  channel: UploadChannel
  onDelete?: () => void
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
  const updateInProgress = useRef(false)

  const updateProduct = async (group: ProductGroup) => {
    if (updateInProgress.current) return
    const groupNames = names[group.group_id] ?? {}
    if (group.variations.some((variation) => !(groupNames[variation] ?? '').trim())) {
      setError('Enter a Standard Product Name for every detected variation.')
      return
    }
    updateInProgress.current = true
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
      const pendingAfterUpdate = groups.filter((item) => item.group_id !== group.group_id)
      setGroups(pendingAfterUpdate)
      onPendingGroupsChange(pendingAfterUpdate)
      const refresh = await fetch(`/api/uploads/${path}/${uploadId}/product-review`)
      const refreshed = await refresh.json()
      if (!refresh.ok) throw new Error(refreshed.detail ?? 'Unable to refresh Product Review.')
      if (refreshed.completed) {
        setGroups([])
        onPendingGroupsChange([])
        setReviewCompleted(true)
        setNotice(`Updated ${result.updated_records} record${result.updated_records === 1 ? '' : 's'} successfully.`)
        onComplete()
      } else {
        const remainingGroups = refreshed.groups.filter((item: ProductGroup) => item.group_id !== group.group_id)
        setGroups(remainingGroups)
        onPendingGroupsChange(remainingGroups)
        setNotice(
          `Updated ${result.updated_records} record${result.updated_records === 1 ? '' : 's'} successfully. `
          + `${remainingGroups.length} similar product group${remainingGroups.length === 1 ? '' : 's'} still require review.`,
        )
        setNames(Object.fromEntries(refreshed.groups.map((item: ProductGroup) => [
          item.group_id,
          Object.fromEntries(item.variations.map((variation) => [variation, variation])),
        ])))
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to update this product group.')
    } finally {
      updateInProgress.current = false
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
        <div className="review-header-actions"><div className="review-count"><strong>{groups.length}</strong><span>groups remaining</span></div>{onDelete && <button className="delete-button discard-upload" type="button" onClick={onDelete}>Delete upload</button>}</div>
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

function SavingDataset({ channel }: { channel: UploadChannel }) {
  return (
    <div className="content category-page">
      <section className="review-complete">
        <div className="saving-spinner" /><h2>Saving {channelDisplayName(channel)} dataset</h2>
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
    if (!window.confirm(`Delete "${record.file_name}"?\n\nThis will permanently delete the dataset and all of its stored ${channelDisplayName(record.channel)} rows from PostgreSQL. You can then upload a replacement file.`)) return
    setDeleting(record.upload_id)
    try {
      const response = await fetch(`/api/uploads/history/${record.upload_id}`, { method: 'DELETE' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to delete this dataset.')
      clearDashboardCache()
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
              <td><span className="dataset-id" title={record.upload_id}>{record.upload_id.slice(0, 8)}…</span></td><td className="history-file">{record.file_name}</td><td><span className={`channel-badge ${record.channel.toLowerCase()}`}>{channelDisplayName(record.channel)}</span></td>
              <td>{new Date(record.uploaded_at).toLocaleString('en-IN')}</td><td>{record.uploaded_by}</td><td>{record.total_records.toLocaleString('en-IN')}</td><td><span className="status-complete">{record.upload_status}</span></td>
              <td><button className="delete-button" disabled={deleting === record.upload_id} onClick={() => remove(record)}>{deleting === record.upload_id ? 'Deleting…' : 'Delete'}</button></td>
            </tr>)}
          </tbody></table></div>
        )}
      </section>
    </div>
  )
}

type ManagedPlan = {
  year: number
  channel: string
  monthly_plan: number
  quarterly_plan: number
  yearly_plan: number
  saved: boolean
  protected_default?: boolean
  derived_from_legacy?: boolean
}

type ManagedCategoryPlan = Omit<ManagedPlan, 'channel'> & { category: string }

const PLAN_CHANNELS = ['Digital Online', 'In Office', 'Stall', 'Bulk', 'Call', 'Retail', 'Course Promotion', 'Language Lab', 'OTT']
const PLAN_CATEGORIES = ['Books', 'Web Version', 'Audio Device', 'Pen Drive']

function PlanUpdationPage() {
  const currentYear = new Date().getFullYear()
  const selectableYears = Array.from({ length: 12 }, (_, index) => 2026 + index)
  const [year, setYear] = useState(Math.max(currentYear, 2026))
  const [plans, setPlans] = useState<ManagedPlan[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [categoryPlans, setCategoryPlans] = useState<ManagedCategoryPlan[]>([])
  const [categoryDrafts, setCategoryDrafts] = useState<Record<string, string>>({})
  const [planView, setPlanView] = useState<'channel' | 'category'>('channel')
  const [loading, setLoading] = useState(true)
  const [busyChannel, setBusyChannel] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetch(`/api/plans?year=${year}`)
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail ?? 'Unable to load plans.')
        return result
      })
      .then((result) => {
        if (!active) return
        setPlans(result.plans)
        setDrafts(Object.fromEntries(result.plans.map((plan: ManagedPlan) => [plan.channel, String(plan.monthly_plan)])))
        setLoading(false)
      })
      .catch((reason: unknown) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : 'Unable to load plans.')
        setLoading(false)
      })
    return () => { active = false }
  }, [year])

  useEffect(() => {
    let active = true
    fetch(`/api/plans/categories?year=${year}`)
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.detail ?? 'Unable to load category plans.')
        return result
      })
      .then((result) => {
        if (!active) return
        setCategoryPlans(result.plans)
        setCategoryDrafts(Object.fromEntries(result.plans.map((plan: ManagedCategoryPlan) => [plan.category, String(plan.monthly_plan)])))
        setLoading(false)
      })
      .catch((reason: unknown) => {
        if (!active) return
        setError(reason instanceof Error ? reason.message : 'Unable to load category plans.')
        setLoading(false)
      })
    return () => { active = false }
  }, [year])

  const save = async (channel: string) => {
    const monthlyPlan = Number(drafts[channel])
    if (!Number.isSafeInteger(monthlyPlan) || monthlyPlan < 0) {
      setError('Enter a valid whole-number monthly plan.')
      return
    }
    setBusyChannel(channel)
    setMessage('')
    setError('')
    try {
      const response = await fetch('/api/plans', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, channel, monthly_plan: monthlyPlan }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to save the plan.')
      clearDashboardCache()
      setPlans((current) => current.map((plan) => plan.channel === channel
        ? { ...plan, ...result, saved: true, derived_from_legacy: false }
        : plan))
      setMessage(`${channel} plan for ${year} saved successfully.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save the plan.')
    } finally {
      setBusyChannel('')
    }
  }

  const remove = async (plan: ManagedPlan) => {
    if (!window.confirm(`Delete the ${plan.channel} plan for ${plan.year}? This will not affect any other year or channel.`)) return
    setBusyChannel(plan.channel)
    setMessage('')
    setError('')
    try {
      const response = await fetch(`/api/plans/${plan.year}/${encodeURIComponent(plan.channel)}`, { method: 'DELETE' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to delete the plan.')
      clearDashboardCache()
      setPlans((current) => current.map((item) => item.channel === plan.channel
        ? { ...item, monthly_plan: 0, quarterly_plan: 0, yearly_plan: 0, saved: false, derived_from_legacy: false }
        : item))
      setDrafts((current) => ({ ...current, [plan.channel]: '0' }))
      setMessage(`${plan.channel} plan for ${plan.year} deleted successfully.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to delete the plan.')
    } finally {
      setBusyChannel('')
    }
  }

  const saveCategory = async (category: string) => {
    const monthlyPlan = Number(categoryDrafts[category])
    if (!Number.isSafeInteger(monthlyPlan) || monthlyPlan < 0) {
      setError('Enter a valid whole-number monthly plan.')
      return
    }
    setBusyChannel(category)
    setMessage('')
    setError('')
    try {
      const response = await fetch('/api/plans/categories', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, category, monthly_plan: monthlyPlan }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to save the category plan.')
      clearDashboardCache()
      setCategoryPlans((current) => current.map((plan) => plan.category === category
        ? { ...plan, ...result, saved: true }
        : plan))
      setMessage(`${category} category plan for ${year} saved successfully.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to save the category plan.')
    } finally {
      setBusyChannel('')
    }
  }

  const removeCategory = async (plan: ManagedCategoryPlan) => {
    if (!window.confirm(`Delete the ${plan.category} category plan for ${plan.year}? Other plans will not be affected.`)) return
    setBusyChannel(plan.category)
    setMessage('')
    setError('')
    try {
      const response = await fetch(`/api/plans/categories/${plan.year}/${encodeURIComponent(plan.category)}`, { method: 'DELETE' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to delete the category plan.')
      clearDashboardCache()
      setCategoryPlans((current) => current.map((item) => item.category === plan.category
        ? { ...item, monthly_plan: 0, quarterly_plan: 0, yearly_plan: 0, saved: false }
        : item))
      setCategoryDrafts((current) => ({ ...current, [plan.category]: '0' }))
      setMessage(`${plan.category} category plan for ${plan.year} deleted successfully.`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to delete the category plan.')
    } finally {
      setBusyChannel('')
    }
  }

  const amount = (value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`

  return <div className="content plan-page">
    <section className="intro">
      <div><span className="section-kicker">Yearly plan management</span><h2>Plan Updation</h2><p>Maintain one monthly plan per year and channel. Quarterly and yearly values are calculated automatically.</p></div>
    </section>
    <section className="plan-year-panel">
      <label><span>Select year</span><select value={year} onChange={(event) => { setLoading(true); setError(''); setYear(Number(event.target.value)); setMessage('') }}>{selectableYears.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
      {year === 2026 && <div className="plan-protected-note"><Icon name="info" size={17} /><span>The existing 2026 plan is protected and remains unchanged.</span></div>}
    </section>
    <div className="plan-view-tabs" role="tablist" aria-label="Plan type"><button type="button" role="tab" aria-selected={planView === 'channel'} className={planView === 'channel' ? 'active' : ''} onClick={() => setPlanView('channel')}>Channel Plans</button><button type="button" role="tab" aria-selected={planView === 'category'} className={planView === 'category' ? 'active' : ''} onClick={() => setPlanView('category')}>Category Plans</button></div>
    {message && <div className="success-message plan-message"><span className="success-icon">✓</span><span>{message}</span></div>}
    {error && <div className="error-message plan-message"><Icon name="info" size={18} /><span>{error}</span></div>}
    {loading ? <div className="dashboard-loading">Loading plans…</div> : planView === 'channel' ? <section className="plan-grid" aria-label={`${year} channel plans`}>
      {PLAN_CHANNELS.map((channel) => {
        const plan = plans.find((item) => item.channel === channel)
        const monthly = Number(drafts[channel] ?? 0) || 0
        const isProtected = year === 2026
        const busy = busyChannel === channel
        return <article className="plan-card" key={channel}>
          <div className="plan-card-head"><div><span>Channel</span><h3>{channel}</h3></div><span className={plan?.saved ? 'plan-status saved' : isProtected ? 'plan-status protected' : 'plan-status'}>{plan?.saved ? 'Saved' : isProtected ? '2026 default' : plan?.derived_from_legacy ? 'Legacy total' : 'Not saved'}</span></div>
          <label className="plan-input"><span>Monthly plan</span><div><span>₹</span><input type="number" min="0" step="1" value={drafts[channel] ?? ''} disabled={isProtected || busy} onChange={(event) => setDrafts((current) => ({ ...current, [channel]: event.target.value }))} /></div></label>
          <div className="plan-calculations"><div><span>Quarterly (×3)</span><strong>{amount(monthly * 3)}</strong></div><div><span>Yearly (×12)</span><strong>{amount(monthly * 12)}</strong></div></div>
          <div className="plan-actions"><button className="primary-button" type="button" disabled={isProtected || busy} onClick={() => { void save(channel) }}>{busy ? 'Saving…' : plan?.saved ? 'Updated' : 'Save'}</button><button className="plan-delete-button" type="button" disabled={isProtected || !plan?.saved || busy} onClick={() => { if (plan) void remove(plan) }}>Delete</button></div>
        </article>
      })}
    </section> : <section className="plan-grid plan-category-grid" aria-label={`${year} category plans`}>
      {PLAN_CATEGORIES.map((category) => {
        const plan = categoryPlans.find((item) => item.category === category)
        const monthly = Number(categoryDrafts[category] ?? 0) || 0
        const isProtected = year === 2026
        const busy = busyChannel === category
        return <article className="plan-card" key={category}>
          <div className="plan-card-head"><div><span>Category</span><h3>{category}</h3></div><span className={plan?.saved ? 'plan-status saved' : isProtected ? 'plan-status protected' : 'plan-status'}>{plan?.saved ? 'Saved' : isProtected ? '2026 default' : 'Not saved'}</span></div>
          <label className="plan-input"><span>Monthly plan</span><div><span>₹</span><input type="number" min="0" step="1" value={categoryDrafts[category] ?? ''} disabled={isProtected || busy} onChange={(event) => setCategoryDrafts((current) => ({ ...current, [category]: event.target.value }))} /></div></label>
          <div className="plan-calculations"><div><span>Quarterly (×3)</span><strong>{amount(monthly * 3)}</strong></div><div><span>Yearly (×12)</span><strong>{amount(monthly * 12)}</strong></div></div>
          <div className="plan-actions"><button className="primary-button" type="button" disabled={isProtected || busy} onClick={() => { void saveCategory(category) }}>{busy ? 'Saving…' : plan?.saved ? 'Updated' : 'Save'}</button><button className="plan-delete-button" type="button" disabled={isProtected || !plan?.saved || busy} onClick={() => { if (plan) void removeCategory(plan) }}>Delete</button></div>
        </article>
      })}
    </section>}
  </div>
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
        await completeAndShowHistory(result.upload_id, uploadedUnmatched, true)
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

  const completeAndShowHistory = async (
    id = uploadId,
    unmatchedOverride: DirectUnmatched | null = null,
    reviewsVerified = false,
  ) => {
    let saveStarted = false
    try {
      const path = channelPath(selectedChannel)
      if (!reviewsVerified && (selectedChannel === 'DSG' || selectedChannel === 'Direct Sales')) {
        const categoryResponse = await fetch(`/api/uploads/${path}/${id}/category-review`)
        const categoryResult = await categoryResponse.json()
        if (!categoryResponse.ok) throw new Error(categoryResult.detail ?? 'Unable to verify Category Review status.')
        if (!categoryResult.completed) {
          setReviewRows(categoryResult.records)
          setWorkflowPage('category')
          throw new Error('Complete Category Review before saving the dataset.')
        }
      }

      if (!reviewsVerified) {
        const productResponse = await fetch(`/api/uploads/${path}/${id}/product-review`)
        const productResult = await productResponse.json()
        if (!productResponse.ok) throw new Error(productResult.detail ?? 'Unable to verify Product Review status.')
        if (!productResult.completed) {
          setProductGroups(productResult.groups)
          setWorkflowPage('product')
          throw new Error('Complete Product Review before saving the dataset.')
        }
      }

      saveStarted = true
      setWorkflowPage('saving')
      const response = await fetch(`/api/uploads/${path}/${id}/complete`, { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? 'Unable to save the DSG dataset.')
      clearDashboardCache()
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
      setFile(null)
      setInventoryFile(null)
      setDirectUnmatched(null)
      setUploadState('idle')
      setActiveModule('history')
      setWorkflowPage('upload')
      window.setTimeout(() => {
        window.alert(`${channelDisplayName(selectedChannel)} dataset saved successfully.\nDataset ID: ${result.upload_id}${summary}`)
      }, 0)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Unable to save the DSG dataset.'
      setError(message)
      if (saveStarted) setWorkflowPage('upload')
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
        await completeAndShowHistory(uploadId, null, true)
      } else {
        setProductGroups(result.groups)
        setWorkflowPage('product')
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Unable to continue.')
    }
  }

  const discardPendingUpload = async () => {
    if (!uploadId || !window.confirm(`Delete this unfinished ${channelDisplayName(selectedChannel)} upload?\n\nYou can upload corrected or replacement files afterwards.`)) return
    try {
      const path = channelPath(selectedChannel)
      const response = await fetch(`/api/uploads/${path}/${uploadId}`, { method: 'DELETE' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.detail ?? `Unable to delete the ${channelDisplayName(selectedChannel)} upload.`)
      sessionStorage.removeItem('dsgUpload')
      setUploadId('')
      setReviewRows([])
      setProductGroups([])
      setFile(null)
      setInventoryFile(null)
      setDirectUnmatched(null)
      setUploadState('idle')
      setWorkflowPage('upload')
      setError('')
    } catch (reason) {
      window.alert(reason instanceof Error ? reason.message : `Unable to delete the ${channelDisplayName(selectedChannel)} upload.`)
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div><strong>MIS Sales</strong><span>Dashboard</span></div>
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
      </aside>

      <main>
        <header className="topbar">
          <div>
            <p className="eyebrow">MIS Sales / {activeLabel}</p>
            <h1>{activeLabel}</h1>
          </div>
          <div className="environment"><span /> Production</div>
        </header>

        {activeModule === 'dashboard' ? <DashboardPage /> : activeModule === 'reports' ? <ReportCenter /> : activeModule === 'plans' ? <PlanUpdationPage /> : activeModule === 'history' ? <UploadHistoryPage /> : activeModule !== 'upload' ? <Placeholder title={activeLabel} /> : workflowPage === 'category' ? (
          <CategoryReview uploadId={uploadId} initialRows={reviewRows} channel={selectedChannel} onBack={() => setWorkflowPage('upload')} onContinue={continueAfterCategory} onDelete={selectedChannel === 'Direct Sales' ? () => { void discardPendingUpload() } : undefined} />
        ) : workflowPage === 'product' ? (
          <ProductReview uploadId={uploadId} initialGroups={productGroups} channel={selectedChannel} onPendingGroupsChange={setProductGroups} onComplete={() => { void completeAndShowHistory(uploadId, null, true) }} onDelete={selectedChannel === 'Amazon' || selectedChannel === 'Direct Sales' ? () => { void discardPendingUpload() } : undefined} />
        ) : workflowPage === 'saving' ? (
          <SavingDataset channel={selectedChannel} />
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
                  className={`channel-card ${channel.name === selectedChannel ? 'selected' : 'available'}`}
                  key={channel.name}
                  onClick={() => {
                    if (channel.name === 'DSG' || channel.name === 'SFH' || channel.name === 'Amazon' || channel.name === 'Direct Sales') {
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
                  <div><h3>{channelDisplayName(channel.name)}</h3><span>{channel.status}</span></div>
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
                <div><span className="panel-number">01</span><div><h2>Upload {channelDisplayName(selectedChannel)} dataset{selectedChannel === 'Direct Sales' ? 's' : ''}</h2><p>{selectedChannel === 'Direct Sales' ? 'Upload both mandatory files before validation and mapping.' : 'Upload one complete file for validation and processing.'}</p></div></div>
                <span className="format-pill">CSV · XLSX · XLS</span>
              </div>

              {!file ? (
                <div className={`drop-zone ${uploadState === 'error' ? 'has-error' : ''}`}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => { event.preventDefault(); selectFile(event.dataTransfer.files[0]) }}
                  onClick={() => fileInput.current?.click()}>
                  <div className="upload-orbit"><Icon name="cloud" size={30} /></div>
                  <h3>Drop your {selectedChannel === 'Direct Sales' ? 'Invoice Dataset' : `${channelDisplayName(selectedChannel)} dataset`} here</h3>
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
                <div><strong>Before you upload</strong><p>{selectedChannel === 'DSG' ? 'Your DSG file must include Order Number, Product Name, Category, and Item Cost × Quantity.' : selectedChannel === 'SFH' ? 'Your SFH file must include Course, Currency, Without Tax Total, and Earnings. Category will be set automatically to Web Version.' : selectedChannel === 'Amazon' ? 'Your Amazon file must include product-name, currency, item-price, and ship-state. Category will be set automatically to Books.' : 'Invoice requires Invoice Number, Without Tax Total, and Private Notes. Sales Inventory requires Doc No., Category, Item Details, and Qty. Only matching identifiers will be processed; unmatched records are logged.'} Existing columns and calculations will be preserved.</p></div>
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
