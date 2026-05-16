import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    collection,
    deleteDoc,
    doc,
    getDocs,
    getFirestore,
    onSnapshot,
    query,
    setDoc,
    updateDoc,
    where,
    writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    getAuth,
    inMemoryPersistence,
    onAuthStateChanged,
    setPersistence,
    signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// IMPORTANTE: este módulo es el único punto de configuración Firebase para evitar duplicar credenciales.
const firebaseConfig = {
    apiKey: "AIzaSyBXylL77z6EPDy2EuXVLLF_hkW8CyQvns4",
    authDomain: "crm-futbol.firebaseapp.com",
    projectId: "crm-futbol",
    storageBucket: "crm-futbol.firebasestorage.app",
    messagingSenderId: "222709021751",
    appId: "1:222709021751:web:94168589472c2ee938d3b2"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// IMPORTANTE: reexportar helpers de Firestore/Auth mantiene main.js libre de URLs CDN repetidas.
export {
    collection,
    deleteDoc,
    doc,
    getDocs,
    inMemoryPersistence,
    onAuthStateChanged,
    onSnapshot,
    query,
    setDoc,
    setPersistence,
    signInAnonymously,
    updateDoc,
    where,
    writeBatch
};
