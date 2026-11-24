import React from 'react';
import {createRoot} from 'react-dom/client';
import {ApiProvider} from '../../apps/shop/src/api';
import {setLocaleResolver} from '../../apps/shop/shared/i18n';
import '../../apps/shop/src/style.css';
import './page.css';
import {FinderEditor,siteApi} from './FinderEditor';
if (document.documentElement.lang === 'en') setLocaleResolver(() => 'en');
createRoot(document.getElementById('root')!).render(<ApiProvider value={siteApi}><FinderEditor/></ApiProvider>);
