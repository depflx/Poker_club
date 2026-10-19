'use client';

import { useState } from 'react';

interface NDEFReaderLike {
  scan: () => Promise<void>;
  onreading: ((e: { serialNumber: string }) => void) | null;
  onreadingerror: (() => void) | null;
}

/**
 * Card ID field. On Android Chrome the Tap button reads the card's serial number with Web NFC;
 * everywhere else, or if the read fails, the ID can be typed or pasted.
 */
export function CardInput({ name = 'uid', required = true, label = 'Card ID' }: { name?: string; required?: boolean; label?: string }) {
  const [value, setValue] = useState('');
  const [state, setState] = useState<'idle' | 'reading' | 'unsupported' | 'error'>('idle');

  async function tap() {
    if (!('NDEFReader' in window)) return setState('unsupported');
    try {
      const Reader = (window as unknown as { NDEFReader: new () => NDEFReaderLike }).NDEFReader;
      const reader = new Reader();
      setState('reading');
      await reader.scan();
      reader.onreading = (e) => {
        setValue(e.serialNumber.replace(/:/g, '').toUpperCase());
        setState('idle');
      };
      reader.onreadingerror = () => setState('error');
    } catch {
      setState('error');
    }
  }

  return (
    <div>
      <label htmlFor={`${name}-field`}>{label}</label>
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input
          id={`${name}-field`}
          name={name}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required={required}
          autoComplete="off"
          placeholder="Tap or type the card ID"
        />
        <button type="button" className="btn" onClick={tap}>Tap card</button>
      </div>
      {state === 'reading' && <p className="sub" role="status">Hold the card to the back of the phone.</p>}
      {state === 'unsupported' && <p className="sub">Tap-to-read needs Chrome on Android. Type the card ID instead.</p>}
      {state === 'error' && <p className="sub">Could not read the card. Try again or type the ID.</p>}
    </div>
  );
}
