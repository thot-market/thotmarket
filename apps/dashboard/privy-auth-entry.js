import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {PrivyProvider, usePrivy, useWallets, useLogin, useModalStatus, useCreateWallet} from '@privy-io/react-auth';
import {eligiblePrivyWallets, selectPrivyWallet, validatePrivyConfig} from './privy-auth-state.js';

const chains = {
  31337: {id: 31337, name: 'Private Anvil', nativeCurrency: {name: 'Test Ether', symbol: 'ETH', decimals: 18}, testnet: true},
  46630: {id: 46630, name: 'Robinhood Chain Testnet', nativeCurrency: {name: 'Test Ether', symbol: 'ETH', decimals: 18}, rpcUrls: {default: {http: ['https://rpc.testnet.chain.robinhood.com']}}, blockExplorers: {default: {name: 'Robinhood Explorer', url: 'https://explorer.testnet.chain.robinhood.com'}}, testnet: true},
  4663: {id: 4663, name: 'Robinhood Chain', nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18}, rpcUrls: {default: {http: ['https://rpc.mainnet.chain.robinhood.com']}}, blockExplorers: {default: {name: 'Robinhood Explorer', url: 'https://robinhoodchain.blockscout.com'}}}
};

/** Privy supplies wallets. Only our server's signed SIWE challenge opens the private vault. */
export function createPrivyAuth({document, window, config, walletAuth, onError = () => {}}) {
  const publicConfig = validatePrivyConfig(config);
  const chain = {...chains[publicConfig.chainId], rpcUrls:{default:{http:[publicConfig.rpcUrl]}}};
  const providerConfig = {appId: publicConfig.appId, ...(publicConfig.clientId ? {clientId: publicConfig.clientId} : {})};
  let current = null, target = null, root = null, destroyed = false, generation = 0, selectedAddress = null, signing = false, loginOpening = null;
  let readyResolve, readyReject, renderTick = () => {}, openRequested = false, loginAttempt = false, loginAddress = null, priorUser, modalWasOpen = false;
  const initialized = new Promise((resolve, reject) => {readyResolve = resolve; readyReject = reject;});
  const timer = window.setTimeout(() => readyReject(new Error('Privy did not load. Check the connection and try again.')), 30000);
  const host = document.createElement('div'); host.id = 'privy-auth-root'; document.body.appendChild(host);
  const fail = error => onError(error instanceof Error ? error : new Error('Privy sign-in could not complete.'));
  function settleLoginOpening(error) {loginOpening?.(error);}
  function waitForLoginModal(epoch) {
    return new Promise((resolve, reject) => {
      const browser = document.defaultView ?? window;
      let observer, deadline, done = false;
      const finish = error => {
        if(done)return;done=true;window.clearTimeout(deadline);observer?.disconnect();
        if(loginOpening===finish)loginOpening=null;
        error ? reject(error) : resolve();
      };
      loginOpening=finish;
      const check = () => {
        if(destroyed||epoch!==generation||!loginAttempt||current?.authenticated)return finish();
        // Privy 3.42 opens its dialog shell before importing the landing screen.
        // Wait for a usable control, not the shell, heading, spinner or close icon.
        const content=document.querySelector('#privy-modal-content');
        for(const control of content?.querySelectorAll('input:not([type="hidden"]),button')??[]){
          if(control.disabled||control.getAttribute('aria-disabled')==='true'||control.closest('[hidden],[aria-hidden="true"]')||!control.getClientRects().length)continue;
          const style=browser.getComputedStyle(control);
          if(style.display==='none'||style.visibility==='hidden')continue;
          if(control.tagName==='INPUT'&&!control.readOnly||control.tagName==='BUTTON'&&control.textContent.trim())return finish();
        }
      };
      observer=new browser.MutationObserver(check);
      observer.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','readonly','hidden','style','class','aria-hidden','aria-disabled']});
      deadline=window.setTimeout(()=>{
        const error=new Error('Sign-in options could not load. Please try again.');error.code='PRIVY_LOGIN_OPEN_FAILED';finish(error);
      },30000);
      check();
    });
  }
  const walletWaiters = new Set();
  const notifyWalletWaiters = () => {for (const check of [...walletWaiters]) check();};
  function waitForWallets(epoch, userId) {
    return new Promise((resolve, reject) => {
      const finish = error => {window.clearTimeout(deadline); walletWaiters.delete(check); error ? reject(error) : resolve();};
      const check = () => {
        if (destroyed || epoch !== generation || current?.ready && (!current.authenticated || current.user?.id !== userId || current.walletsReady)) finish();
      };
      const deadline = window.setTimeout(() => finish(new Error('Your wallets are still loading. Please try sign-in again.')), 30000);
      walletWaiters.add(check); check();
    });
  }
  const changed = () => {generation++; settleLoginOpening(); selectedAddress = null; openRequested = false; loginAttempt = false; loginAddress = null; void walletAuth.signOut().catch(fail);};

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
    const {login} = useLogin({onComplete: ({loginAccount}) => {if (!loginAttempt || destroyed) return; loginAddress = loginAccount?.type === 'wallet' && loginAccount.chainType === 'ethereum' ? loginAccount.address : null; openRequested = true; tick(n => n + 1);}, onError: () => {openRequested = false; loginAttempt = false; settleLoginOpening(); fail(new Error('Privy login was cancelled or could not complete.'));}});
    renderTick = () => {if (!destroyed) tick(n => n + 1);};
    useEffect(() => {
      current = {...auth, wallets: walletState.wallets, walletsReady: walletState.ready, login};
      if(auth.ready&&auth.authenticated)settleLoginOpening();
      if (auth.ready) {
        const identity = auth.authenticated ? auth.user?.id : null;
        if (priorUser != null && priorUser !== identity) changed();
        priorUser = identity;
      }
      if (modalWasOpen && !modal.isOpen && !auth.authenticated) {loginAttempt = false; openRequested = false; settleLoginOpening();}
      modalWasOpen = modal.isOpen;
      notifyWalletWaiters();
      if (!auth.ready) return;
      // Opening anonymous login needs authentication readiness, not connected wallets.
      // Wallet restore/selection still waits for the separate wallet readiness gate.
      if (!auth.authenticated || walletState.ready) {window.clearTimeout(timer); readyResolve();}
      if (!walletState.ready) return;
      if (selectedAddress && !eligiblePrivyWallets(auth.user, walletState.wallets).some(w => w.address.toLowerCase() === selectedAddress)) changed();
      if (openRequested && auth.authenticated && !signing) {
        try {const selected = selectPrivyWallet(auth.user, walletState.wallets, loginAddress); if (selected) void useWallet(selected.address);}
        catch (error) {openRequested = false; fail(error);}
      }
    });
    const choices = eligiblePrivyWallets(auth.user, walletState.wallets);
    if (!target || !openRequested || !auth.authenticated || !walletState.ready || choices.length === 1) return null;
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
      if (!current?.ready || current.authenticated && !current.walletsReady || destroyed) throw new Error('Wallet login is still loading.');
      if (loginAttempt || signing) return;
      loginAttempt = true;
      try {
        await walletAuth.signOut(); if (destroyed) return; loginAddress = null; openRequested = true;
        if (current.authenticated) renderTick();
        else {
          const opening=waitForLoginModal(generation);
          try {current.login({loginMethods: ['email', 'wallet'], walletChainType: 'ethereum-only'});}
          catch(error){settleLoginOpening();throw error;}
          await opening;
        }
      }
      catch (error) {loginAttempt = false; openRequested = false; throw error;}
    },
    async providers(address) {
      await initialized;
      if (!current?.authenticated) return [];
      const epoch = generation, userId = current.user?.id;
      await waitForWallets(epoch, userId);
      if (destroyed || epoch !== generation || !current?.authenticated || current.user?.id !== userId) return [];
      const wallet = eligiblePrivyWallets(current.user, current.wallets).find(w => w.address.toLowerCase() === address?.toLowerCase());
      if (!wallet) return [];
      const provider = await wallet.getEthereumProvider();
      if (destroyed || epoch !== generation || current?.user?.id !== userId) return [];
      selectedAddress = wallet.address.toLowerCase(); return [provider];
    },
    async signOut() {generation++; settleLoginOpening(); selectedAddress = null; openRequested = false; loginAttempt = false; loginAddress = null; await walletAuth.signOut(); await current?.logout(); renderTick();},
    destroy() {destroyed = true; generation++; settleLoginOpening(); notifyWalletWaiters(); window.clearTimeout(timer); root?.unmount(); host.remove(); current = null;}
  };
}
