import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  type Auth,
  type User,
  signInWithPopup,
  GoogleAuthProvider,
  FacebookAuthProvider,
  GithubAuthProvider,
  OAuthProvider,
  signOut as firebaseSignOut,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  updateProfile,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
} from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getAnalytics, type Analytics, isSupported as isAnalyticsSupported } from 'firebase/analytics';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let analytics: Analytics | null = null;
let firebaseInitialized = false;

const requiredConfigKeys: (keyof typeof firebaseConfig)[] = ['apiKey', 'authDomain', 'projectId'];
const missingKeys = requiredConfigKeys.filter(key => !firebaseConfig[key]);

if (missingKeys.length === 0) {
  try {
    app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
    if (firebaseConfig.appId) {
      void isAnalyticsSupported().then(supported => {
        if (supported && app) analytics = getAnalytics(app);
      }).catch(() => {
        // Analytics is optional and must never prevent the app from starting.
      });
    }
    firebaseInitialized = true;
  } catch {
    // Keep the public app usable when Firebase is not configured correctly.
    console.warn('Firebase initialization failed; authentication and database features are unavailable.');
  }
} else {
  console.warn('Firebase configuration is incomplete; authentication and database features are unavailable.');
}

const authNotConfiguredError = 'Firebase authentication is not configured. Set the public VITE_FIREBASE_* project settings in the build environment.';

const onAuthUserChanged = (callback: (user: User | null) => void) => {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback);
};

export const signInWithGoogle = () => {
  if (!auth) return Promise.reject(new Error(authNotConfiguredError));
  return signInWithPopup(auth, new GoogleAuthProvider());
};

export const signInWithFacebook = () => {
  if (!auth) return Promise.reject(new Error(authNotConfiguredError));
  return signInWithPopup(auth, new FacebookAuthProvider());
};

export const signInWithGithub = () => {
  if (!auth) return Promise.reject(new Error(authNotConfiguredError));
  return signInWithPopup(auth, new GithubAuthProvider());
};

export const signInWithMicrosoft = () => {
  if (!auth) return Promise.reject(new Error(authNotConfiguredError));
  return signInWithPopup(auth, new OAuthProvider('microsoft.com'));
};

export const signUpWithEmail = async (name: string, email: string, password: string): Promise<User> => {
  if (!auth) throw new Error(authNotConfiguredError);
  const credential = await createUserWithEmailAndPassword(auth, email, password);
  await updateProfile(credential.user, { displayName: name });
  await sendEmailVerification(credential.user);
  return credential.user;
};

export const signInWithEmail = (email: string, password: string, stayLoggedIn: boolean) => {
  if (!auth) return Promise.reject(new Error(authNotConfiguredError));
  const persistence = stayLoggedIn ? browserLocalPersistence : browserSessionPersistence;
  return setPersistence(auth, persistence).then(() => signInWithEmailAndPassword(auth, email, password));
};

export const sendPasswordReset = (email: string) => {
  if (!auth) return Promise.reject(new Error(authNotConfiguredError));
  return sendPasswordResetEmail(auth, email);
};

export const signOut = () => {
  if (!auth) return Promise.reject(new Error(authNotConfiguredError));
  return firebaseSignOut(auth);
};

export { auth, db, analytics, onAuthUserChanged, firebaseInitialized };
