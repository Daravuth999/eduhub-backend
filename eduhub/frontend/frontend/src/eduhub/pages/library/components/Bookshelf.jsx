import { useRef } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import BookCard from './BookCard.jsx'

const CARD_W = 158 // matches BookCard width + gap

export default function Bookshelf({ meta, items, onCardClick }) {
  const scrollerRef = useRef(null)
  const newCount = items.filter((i) => i._isNew).length

  const scrollBy = (dir) => {
    const el = scrollerRef.current
    if (!el) return
    el.scrollBy({ left: dir * (CARD_W + 14), behavior: 'smooth' })
  }

  return (
    <section data-testid={`shelf-${meta.key}`}>
      {/* Header */}
      <header className="mb-2 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <h3
            className="truncate font-display text-[20px] leading-tight text-parchment"
            style={{ letterSpacing: '-0.01em' }}
          >
            {meta.label}
          </h3>
          <span className="khmer truncate text-xs text-faded">
            {meta.khmer}
          </span>
          {newCount > 0 && (
            <span
              className="tabular ml-1 shrink-0 rounded-full border border-gold/40 bg-gold/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-conic"
              data-testid={`shelf-new-count-${meta.key}`}
            >
              {newCount} new
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ArrowBtn dir="left" onClick={() => scrollBy(-1)} />
          <ArrowBtn dir="right" onClick={() => scrollBy(1)} />
        </div>
      </header>

      {/* Shelf */}
      {items.length === 0 ? (
        <EmptyShelf meta={meta} />
      ) : (
        <div className="relative">
          <div
            ref={scrollerRef}
            className="snap-shelf no-scrollbar shelf-mask flex gap-3.5 overflow-x-auto pb-3 pt-1"
            data-testid={`shelf-scroller-${meta.key}`}
          >
            {items.map((item, idx) => (
              <BookCard
                key={`${meta.key}-${idx}-${item.title}`}
                item={item}
                meta={meta}
                onClick={() => onCardClick(item)}
              />
            ))}
            {/* trailing spacer */}
            <div className="h-1 w-2 flex-none" />
          </div>
          {/* Wooden shelf base */}
          <div
            className="shelf-base relative -mt-1 h-3 rounded-b-md"
            aria-hidden="true"
          />
          <div className="mx-3 h-1.5 rounded-b-lg bg-black/60 blur-[1px]" />
        </div>
      )}
    </section>
  )
}

function ArrowBtn({ dir, onClick }) {
  return (
    <button
      onClick={onClick}
      aria-label={dir === 'left' ? 'Scroll left' : 'Scroll right'}
      data-testid={`shelf-arrow-${dir}`}
      className="grid h-8 w-8 place-items-center rounded-full border border-parchment/10 bg-walnut/70 text-faded transition-all hover:border-gold/40 hover:text-gold active:scale-95"
    >
      {dir === 'left' ? (
        <ChevronLeft className="h-4 w-4" />
      ) : (
        <ChevronRight className="h-4 w-4" />
      )}
    </button>
  )
}

function EmptyShelf({ meta }) {
  return (
    <div
      className="flex h-[160px] flex-col items-center justify-center rounded-2xl border border-dashed border-parchment/10 text-center text-sm text-faded"
      style={{ background: 'rgba(34,24,48,0.5)' }}
    >
      <span className="text-2xl">{meta.emoji}</span>
      <p className="mt-1">No {meta.label.toLowerCase()} yet</p>
      <p className="khmer text-[11px] opacity-70">មិនទាន់មានទេ</p>
    </div>
  )
}
