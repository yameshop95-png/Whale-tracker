import { BellRing, ChefHat, Users, X } from 'lucide-react';
import { NAV_ITEMS } from './navigation';

function Badge({ count, active }) {
  if (!count) return null;
  return (
    <span
      className={`ml-auto min-w-6 rounded-full px-2 py-0.5 text-center text-xs font-bold ${
        active ? 'bg-white text-orange-600' : 'bg-red-500 text-white'
      }`}
    >
      {count > 99 ? '99+' : count}
    </span>
  );
}

export default function Sidebar({ activeTab, onTabChange, counts, activeStaff, isOpen, onClose }) {
  const totalPending = counts.pendingOrders + counts.pendingDelivery;

  return (
    <>
      {/* Lớp nền mờ khi mở sidebar trên mobile */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-slate-900/50 transition-opacity lg:hidden ${
          isOpen ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col bg-slate-900 text-slate-200 transition-transform duration-200 lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Logo quán */}
        <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-5">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-500 text-white">
            <ChefHat size={24} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-lg font-bold text-white">Bếp Nhà</p>
            <p className="text-xs text-slate-400">Dashboard nhận order</p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden"
            aria-label="Đóng menu"
          >
            <X size={20} />
          </button>
        </div>

        {/* Trạng thái nhân viên đang hoạt động */}
        <div className="mx-4 mt-4 flex items-center gap-3 rounded-xl bg-slate-800/60 px-4 py-3">
          <span className="relative flex h-2.5 w-2.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
          </span>
          <Users size={16} className="text-slate-400" />
          <span className="text-sm">
            <span className="font-semibold text-white">{activeStaff}</span> người đang hoạt động
          </span>
        </div>

        {/* Ưu tiên cao: thanh cảnh báo đơn mới chờ xử lý */}
        {totalPending > 0 && (
          <button
            onClick={() => onTabChange('orders')}
            className="mx-4 mt-3 flex items-center gap-3 rounded-xl bg-red-500 px-4 py-3 text-left text-white shadow-lg shadow-red-500/30 ring-2 ring-red-400/50 transition hover:bg-red-600"
          >
            <BellRing size={22} className="shrink-0 animate-bounce" />
            <div className="min-w-0">
              <p className="text-sm font-bold">{totalPending} đơn mới chờ xử lý</p>
              <p className="text-xs text-red-100">
                {counts.pendingOrders} tại quán · {counts.pendingDelivery} ship
              </p>
            </div>
          </button>
        )}

        {/* Menu 5 tabs */}
        <nav className="mt-4 flex-1 space-y-1 overflow-y-auto px-3">
          {NAV_ITEMS.map(({ id, label, icon: Icon, badgeKey }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                onClick={() => onTabChange(id)}
                aria-current={active ? 'page' : undefined}
                className={`flex w-full items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium transition ${
                  active
                    ? 'bg-orange-500 text-white shadow-md shadow-orange-500/20'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Icon size={20} />
                <span>{label}</span>
                <Badge count={badgeKey ? counts[badgeKey] : 0} active={active} />
              </button>
            );
          })}
        </nav>

        <div className="border-t border-slate-800 px-5 py-4 text-xs text-slate-500">v0.1.0 · Ca sáng</div>
      </aside>
    </>
  );
}
