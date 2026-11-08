import { useEffect } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/** BrowserRouter keeps the window's scroll offset across navigations, so a
 *  recipe opened from the bottom of a long list opened at ITS bottom. A new
 *  page starts at the top; Back/Forward (POP) are left to the browser. */
export default function ScrollToTop() {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  useEffect(() => {
    if (navigationType !== 'POP') window.scrollTo(0, 0);
  }, [pathname, navigationType]);
  return null;
}
