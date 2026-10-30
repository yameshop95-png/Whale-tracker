import { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar';
import TopBar from './components/TopBar';
import { HomePage, OrdersPage, DeliveryPage, MenuPage, SettingsPage } from './pages';

// Map id tab -> component hiển thị trong Main Content Area.
const PAGES = {
  home: HomePage,
  orders: OrdersPage,
  delivery: DeliveryPage,
  menu: MenuPage,
  settings: SettingsPage,
};

export default function App() {
  const [activeTab, setActiveTab] = useState('home');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeStaff] = useState(4);
  const [counts, setCounts] = useState({ pendingOrders: 3, pendingDelivery: 2 });

  // Demo: giả lập có đơn mới đổ về mỗi 20s. Thay bằng WebSocket/API thật khi tích hợp backend.
  useEffect(() => {
    const timer = setInterval(() => {
      setCounts((c) => ({ ...c, pendingOrders: c.pendingOrders + 1 }));
    }, 20000);
    return () => clearInterval(timer);
  }, []);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setSidebarOpen(false);
  };

  const resolveOrder = () =>
    setCounts((c) => ({ ...c, pendingOrders: Math.max(0, c.pendingOrders - 1) }));

  const ActivePage = PAGES[activeTab];
  const pendingTotal = counts.pendingOrders + counts.pendingDelivery;

  return (
    <div className="min-h-screen bg-slate-100">
      <Sidebar
        activeTab={activeTab}
        onTabChange={handleTabChange}
        counts={counts}
        activeStaff={activeStaff}
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />

      <div className="lg:pl-72">
        <TopBar
          activeTab={activeTab}
          pendingTotal={pendingTotal}
          onMenuClick={() => setSidebarOpen(true)}
          onBellClick={() => handleTabChange('orders')}
        />

        <main className="mx-auto max-w-7xl p-4 sm:p-6">
          <ActivePage counts={counts} activeStaff={activeStaff} onResolve={resolveOrder} />
        </main>
      </div>
    </div>
  );
}
