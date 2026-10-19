const PATHS: Record<string, string> = {
  overview: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  floor: 'M2.5 12a9.5 6 0 1 0 19 0 9.5 6 0 1 0-19 0',
  money: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 7.5h7M8.5 11h7M9 7.5c4.2 0 5.5 3.5 0 3.5l5 5.5',
  members: 'M9 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM2.5 20c.6-3.7 3.2-5.5 6.5-5.5s5.9 1.8 6.5 5.5M16 4.8a3.3 3.3 0 0 1 0 6.4M18 14.8c2 .7 3.2 2.3 3.5 5.2',
  audit: 'M12 3l8 3v6c0 4.5-3.2 7.8-8 9-4.8-1.2-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 4.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4zM8 14.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4z',
  owners: 'M3 21V9l9-6 9 6v12M9 21v-6h6v6',
  counter: 'M4 8h16v10H4zM8 8V5h8v3M8 13h8',
  order: 'M5 4h14l-1.5 9H6.5zM9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM16 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  kitchen: 'M6 3v7a3 3 0 0 0 3 3v8M9 3v7M12 3v7M17 3c-2 1-3 4-3 7h3v11',
};

export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.overview} />
    </svg>
  );
}
