import { Bell, Menu } from 'lucide-react';
import { NAV_ITEMS } from './navigation';

// Header cố định phía trên vùng nội dung: tiêu đề tab + chuông thông báo.
export default function TopBar({ activeTab, pendingTotal, onMenuClick, onBellClick }) {
  const current = NAV_ITEMS.find((item) => item.id === activeTab);

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur sm:px-6">
      <button
        onClick={onMenuClick}
        className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
        aria-label="Mở menu"
      >
        <Menu size={22} />
      </button>

      <h1 className="truncate text-lg font-semibold text-slate-800">{current?.label}</h1>

      <button
        onClick={onBellClick}
        className="relative ml-auto rounded-full p-2 text-slate-600 hover:bg-slate-100"
        aria-label={`${pendingTotal} đơn chờ xử lý`}
      >
        <Bell size={22} />
        {pendingTotal > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[11px] font-bold text-white ring-2 ring-white">
            {pendingTotal > 99 ? '99+' : pendingTotal}
          </span>
        )}
      </button>
    </header>
  );
}
