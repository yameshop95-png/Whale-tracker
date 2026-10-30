import { LayoutDashboard, ClipboardList, Bike, UtensilsCrossed, Settings } from 'lucide-react';

// Danh sách 5 tab điều hướng. `badgeKey` trỏ tới bộ đếm hiển thị badge trên menu.
export const NAV_ITEMS = [
  { id: 'home', label: 'Màn hình chính', icon: LayoutDashboard },
  { id: 'orders', label: 'Đơn hàng', icon: ClipboardList, badgeKey: 'pendingOrders' },
  { id: 'delivery', label: 'Đơn ship', icon: Bike, badgeKey: 'pendingDelivery' },
  { id: 'menu', label: 'Quản lý món ăn', icon: UtensilsCrossed },
  { id: 'settings', label: 'Cài đặt app', icon: Settings },
];
