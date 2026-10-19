import Link from 'next/link';
import { ChipStacks, initials, inr } from './ui';

export interface PitSeat {
  seatNumber: number;
  name: string;
  chipsOut: number;
}

function pos(i: number, maxSeats: number, scale: number): [number, number] {
  const a = (-90 + 180 / maxSeats + i * (360 / maxSeats)) * (Math.PI / 180);
  return [50 + 43 * scale * Math.cos(a), 50 + 40 * scale * Math.sin(a)];
}

interface Props {
  maxSeats: number;
  seats: PitSeat[];
  center: { label: string; value: string; sub: string };
  /** When given, an occupied seat becomes a link (to select it). */
  seatHref?: (seatNumber: number) => string;
  selected?: number | null;
  label: string;
}

/** The table seen from above: seats round the rail, chip stacks on the felt, dealer button at the top. */
export function Pit({ maxSeats, seats, center, seatHref, selected, label }: Props) {
  return (
    <div className="pit" role="group" aria-label={label}>
      <div className="felt">
        <div className="ct">
          <small>{center.label}</small>
          <b>{center.value}</b>
          <span>{center.sub}</span>
        </div>
      </div>
      <div className="dealer-btn" title="Dealer">D</div>
      {Array.from({ length: maxSeats }, (_, i) => {
        const n = i + 1;
        const s = seats.find((x) => x.seatNumber === n);
        const [x, y] = pos(i, maxSeats, 1);
        if (!s) {
          return (
            <div key={n} className="seat empty" style={{ left: `${x}%`, top: `${y}%` }}>
              <div className="av">{n}</div>
              <span className="amt">Open</span>
            </div>
          );
        }
        const [cx, cy] = pos(i, maxSeats, 0.68);
        const body = (
          <>
            <div className="av">{initials(s.name)}</div>
            <span className="nm">{s.name}</span>
            <span className="amt">{inr(s.chipsOut)}</span>
          </>
        );
        return (
          <div key={n}>
            {seatHref ? (
              <Link className={`seat ${selected === n ? 'on' : ''}`} style={{ left: `${x}%`, top: `${y}%` }} href={seatHref(n)} aria-label={`Seat ${n}, ${s.name}, chips out ${inr(s.chipsOut)}`}>
                {body}
              </Link>
            ) : (
              <div className="seat" style={{ left: `${x}%`, top: `${y}%` }}>{body}</div>
            )}
            <div className="stk-wrap" style={{ left: `${cx}%`, top: `${cy}%` }}>
              <ChipStacks paise={s.chipsOut} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Small top-down table for overviews: filled dots are seated players. */
export function MiniTable({ seats, maxSeats = 8 }: { seats: number[]; maxSeats?: number }) {
  return (
    <svg viewBox="0 0 120 80" aria-hidden="true">
      <ellipse cx="60" cy="40" rx="38" ry="22" fill="#1D4B3C" stroke="#2B2219" strokeWidth="5" />
      {Array.from({ length: maxSeats }, (_, i) => {
        const a = (-90 + 180 / maxSeats + i * (360 / maxSeats)) * (Math.PI / 180);
        const x = 60 + 52 * Math.cos(a);
        const y = 40 + 31 * Math.sin(a);
        const on = seats.includes(i + 1);
        return (
          <circle key={i} cx={x.toFixed(1)} cy={y.toFixed(1)} r="5.2" fill={on ? '#E2B863' : 'none'}
            stroke={on ? '#E2B863' : '#4A545C'} strokeWidth="1.5" strokeDasharray={on ? undefined : '2.5 2.5'} />
        );
      })}
    </svg>
  );
}
