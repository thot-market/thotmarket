import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {PrivyProvider, usePrivy, useWallets, useLogin, useModalStatus, useCreateWallet} from '@privy-io/react-auth';
import {eligiblePrivyWallets, selectPrivyWallet, validatePrivyConfig} from './privy-auth-state.js';

const chains = {
  31337: {id: 31337, name: 'Private Anvil', nativeCurrency: {name: 'Test Ether', symbol: 'ETH', decimals: 18}, testnet: true},
  46630: {id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: {name: 'Test Ether', symbol: 'ETH', decimals: 18}, rpcUrls: {default: {http: ['https://rpc.testnet.chain.robinhood.com']}}, blockExplorers: {default: {name: 'Robinhood Explorer', url: 'https://explorer.testnet.chain.robinhood.com'}}, testnet: true}
};

/** Privy supplies wallets. Only our server's signed SIWE challenge opens the private vault. */
export function createPrivyAuth({document, window, config, walletAuth, onError = () => {}}) {
  const publicConfig = validatePrivyConfig(config);
  const chain = {...chains[publicConfig.chainId], rpcUrls:{default:{http:[publicConfig.rpcUrl]}}};
  const providerConfig = {appId: publicConfig.appId, ...(publicConfig.clientId ? {clientId: publicConfig.clientId} : {})};
  let current = null, target = null, root = null, destroyed = false, generation = 0, selectedAddress = null, signing = false;
  let readyResolve, readyReject, renderTick = () => {}, openRequested = false, loginAttempt = false, loginAddress = null, priorUser, modalWasOpen = false;
  const initialized = new Promise((resolve, reject) => {readyResolve = resolve; readyReject = reject;});
  const timer = window.setTimeout(() => readyReject(new Error('Privy did not load. Check the connection and try again.')), 30000);
  const host = document.createElement('div'); host.id = 'privy-auth-root'; document.body.appendChild(host);
  const fail = error => onError(error instanceof Error ? error : new Error('Privy sign-in could not complete.'));
  const changed = () => {generation++; selectedAddress = null; openRequested = false; loginAttempt = false; loginAddress = null; void walletAuth.signOut().catch(fail);};

  async function useWallet(address) {
    if (signing || destroyed || !current?.ready || !current.walletsReady || !current.authenticated) return false;
    const wallet = selectPrivyWallet(current.user, current.wallets, address);
    if (!wallet) {openRequested = true; renderTick(); return false;}
    const epoch = generation, userId = current.user.id;
    const check = () => {if (destroyed || epoch !== generation || current?.user?.id !== userId || !eligiblePrivyWallets(current.user, current.wallets).some(w => w.address.toLowerCase() === wallet.address.toLowerCase())) throw new Error('The Privy account changed. Sign in again.');};
    signing = true; openRequested = false; loginAttempt = false; renderTick();
    try {
      await wallet.switchChain(chain.id); check();
      const provider = await wallet.getEthereumProvider(); check();
      const ok = await walletAuth.signInProvider(provider, wallet.address); check();
      if (ok) selectedAddress = wallet.address.toLowerCase();
      return ok;
    } catch (error) {await walletAuth.signOut().catch(fail); fail(error); return false;}
    finally {signing = false; renderTick();}
  }

  function Bridge() {
    const auth = usePrivy(), walletState = useWallets(), modal = useModalStatus(), [, tick] = useState(0);
    const {createWallet} = useCreateWallet();
    const {login} = useLogin({onComplete: ({loginAccount}) => {if (!loginAttempt || destroyed) return; loginAddress = loginAccount?.type === 'wallet' && loginAccount.chainType === 'ethereum' ? loginAccount.address : null; openRequested = true; tick(n => n + 1);}, onError: () => {openRequested = false; loginAttempt = false; fail(new Error('Privy login was cancelled or could not complete.'));}});
    renderTick = () => {if (!destroyed) tick(n => n + 1);};
    useEffect(() => {
      current = {...auth, wallets: walletState.wallets, walletsReady: walletState.ready, login};
      if (auth.ready) {
        const identity = auth.authenticated ? auth.user?.id : null;
        if (priorUser != null && priorUser !== identity) changed();
        priorUser = identity;
      }
      if (modalWasOpen && !modal.isOpen && !auth.authenticated) {loginAttempt = false; openRequested = false;}
      modalWasOpen = modal.isOpen;
      if (!auth.ready || !walletState.ready) return;
      window.clearTimeout(timer); readyResolve();
      if (selectedAddress && !eligiblePrivyWallets(auth.user, walletState.wallets).some(w => w.address.toLowerCase() === selectedAddress)) changed();
      if (openRequested && auth.authenticated && !signing) {
        try {const selected = selectPrivyWallet(auth.user, walletState.wallets, loginAddress); if (selected) void useWallet(selected.address);}
        catch (error) {openRequested = false; fail(error);}
      }
    });
    const choices = eligiblePrivyWallets(auth.user, walletState.wallets);
    if (!target || !openRequested || !auth.authenticated || choices.length === 1) return null;
    if (choices.length === 0) return createPortal(React.createElement('div', {className: 'privy-wallet-choice'},
      React.createElement('p', null, 'Your email is connected. Connect your existing wallet to open its trace library, or create a wallet for a new workspace.'),
      React.createElement('button', {className: 'button secondary', onClick: () => auth.linkWallet({walletChainType: 'ethereum-only'})}, 'Connect existing wallet'),
      !(auth.user?.linkedAccounts ?? []).some(a => a.type === 'wallet' && a.chainType === 'ethereum' && a.walletClientType === 'privy') && React.createElement('button', {className: 'button secondary', onClick: event => {const button=event.currentTarget;button.disabled=true;void createWallet().catch(() => fail(new Error('Your wallet could not be created. Please try again.'))).finally(() => {button.disabled=false;});}}, 'Create email wallet')), target);
    return createPortal(React.createElement('div', {className: 'privy-wallet-choice'},
      React.createElement('p', null, 'Choose the wallet for this workspace. Different wallet addresses have separate trace libraries.'),
      ...choices.map(wallet => React.createElement('button', {key: wallet.address, className: 'button secondary', disabled: signing, onClick: () => void useWallet(wallet.address)}, `${wallet.walletClientType === 'privy' ? 'Email wallet' : 'Connected wallet'} · ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`))), target);
  }

  class Boundary extends React.Component {
    state = {failed: false};
    static getDerivedStateFromError() {return {failed: true};}
    componentDidCatch() {const error = new Error('Privy could not initialize. Verify this site is an allowed origin in your Privy dashboard.'); readyReject(error); fail(error);}
    render() {return this.state.failed ? null : this.props.children;}
  }
  root = createRoot(host);
  root.render(React.createElement(Boundary, null, React.createElement(PrivyProvider, {...providerConfig, config: {
    loginMethods: ['email', 'wallet'], appearance: {theme: 'light', accentColor: '#344b34', walletChainType: 'ethereum-only', walletList: ['metamask', 'phantom', 'detected_wallets', 'wallet_connect']},
    defaultChain: chain, supportedChains: [chain], embeddedWallets: {ethereum: {createOnLogin: 'users-without-wallets'}, showWalletUIs: true}
  }}, React.createElement(Bridge))));

  return {
    initialize: () => initialized,
    mount(element) {target = element; renderTick();},
    async login() {
      if (!current?.ready || !current.walletsReady || destroyed) throw new Error('Wallet login is still loading.');
      if (loginAttempt || signing) return;
      loginAttempt = true;
      try {await walletAuth.signOut(); if (destroyed) return; loginAddress = null; openRequested = true; if (current.authenticated) renderTick(); else current.login({loginMethods: ['email', 'wallet'], walletChainType: 'ethereum-only'});}
      catch (error) {loginAttempt = false; openRequested = false; throw error;}
    },
    async providers(address) {
      await initialized;
      if (!current?.authenticated) return [];
      const epoch = generation, userId = current.user?.id, wallet = eligiblePrivyWallets(current.user, current.wallets).find(w => w.address.toLowerCase() === address?.toLowerCase());
      if (!wallet) return [];
      const provider = await wallet.getEthereumProvider();
      if (destroyed || epoch !== generation || current?.user?.id !== userId) return [];
      selectedAddress = wallet.address.toLowerCase(); return [provider];
    },
    async signOut() {generation++; selectedAddress = null; openRequested = false; loginAttempt = false; loginAddress = null; await walletAuth.signOut(); await current?.logout(); renderTick();},
    destroy() {destroyed = true; generation++; window.clearTimeout(timer); root?.unmount(); host.remove(); current = null;}
  };
}
