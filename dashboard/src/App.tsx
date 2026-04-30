import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import RawPage from './pages/Raw';
import ReportsPage from './pages/Reports';
import SettingsPage from './pages/Settings';
import SummaryPage from './pages/Summary';
import TodayPage from './pages/Today';
import TrendsPage from './pages/Trends';
import { useApplyTheme } from './lib/theme';

export default function App() {
  useApplyTheme();
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<RawPage />} />
        <Route path="/raw" element={<Navigate to="/" replace />} />
        <Route path="/today" element={<TodayPage />} />
        <Route path="/summary" element={<SummaryPage />} />
        <Route path="/trends" element={<TrendsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
