'use client';

export function PrintButton() {
  return <button type="button" className="btn p" onClick={() => window.print()}>Print receipt</button>;
}
