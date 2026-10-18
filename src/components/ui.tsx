// Shared UI primitives for the dashboard -- one button/badge/header recipe
// used across every page instead of each page inventing its own className
// string. Keeps the "modern" pass consistent and gives future pages a
// starting point that already matches.
import type { ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-ghost'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'md' | 'sm'
  icon?: ReactNode
}

export function Button({ variant = 'secondary', size = 'md', icon, children, className = '', ...rest }: ButtonProps) {
  const variantCls = {
    primary: 'btn-primary',
    secondary: 'btn-secondary',
    ghost: 'btn-ghost',
    danger: 'btn-danger',
    'danger-ghost': 'btn-danger-ghost',
  }[variant]
  const sizeCls = size === 'sm' ? 'btn-sm' : ''
  return (
    <button className={`btn ${variantCls} ${sizeCls} ${className}`} {...rest}>
      {icon}
      {children}
    </button>
  )
}

export function IconButton({ className = '', ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`btn-icon ${className}`} {...rest} />
}

export type BadgeVariant = 'brand' | 'good' | 'warn' | 'danger' | 'neutral'

export function Badge({ variant = 'neutral', dot = false, children }: { variant?: BadgeVariant; dot?: boolean; children: ReactNode }) {
  const dotColor = {
    brand: 'var(--color-brand-600)',
    good: 'var(--color-good)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
    neutral: 'var(--color-neutral)',
  }[variant]
  return (
    <span className={`badge badge-${variant}`}>
      {dot && <span className="badge-dot" style={{ backgroundColor: dotColor }} />}
      {children}
    </span>
  )
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
      <div>
        <h1 className="text-xl font-extrabold text-ink tracking-tight">{title}</h1>
        {description && <p className="text-sm text-ink-soft mt-1 max-w-2xl">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="panel py-12 px-6 text-center text-sm text-ink-faint">
      {children}
    </div>
  )
}

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`panel ${className}`}>{children}</div>
}

/** Thin horizontal score bar used by KPI cards (dispatcher/client scorecards). */
export function ScoreBar({ label, value }: { label: string; value: number }) {
  const variant = value >= 75 ? 'good' : value >= 50 ? 'warn' : 'danger'
  const color = {
    good: 'var(--color-good)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  }[variant]
  return (
    <div>
      <div className="flex justify-between text-xs text-ink-soft mb-1">
        <span>{label}</span>
        <span className="tabular-nums font-medium text-ink">{value.toFixed(0)}</span>
      </div>
      <div className="h-1.5 bg-line-soft rounded-full overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, value))}%`, backgroundColor: color }} />
      </div>
    </div>
  )
}
