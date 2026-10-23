// The only Firebase pieces Rack & Run uses. `npm run build:vendor` bundles them into www/vendor/firebase.js.
export { initializeApp } from 'firebase/app';
export { initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, signInAnonymously } from 'firebase/auth';
export { getFirestore, doc, getDoc, setDoc, deleteDoc, onSnapshot, runTransaction, collection, query, where, limit, orderBy, getDocs } from 'firebase/firestore';
