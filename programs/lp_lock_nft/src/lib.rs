//! Locks XDEX (Raydium CP-swap fork) LP tokens for a fixed time behind a 1-of-1 Metaplex NFT.
//!
//! * `lock_lp` moves LP tokens into a vault owned by this program, records the unlock time
//!   and mints a Metaplex NFT (supply 1, master edition with max supply 0) to the locker.
//!   The NFT shows in any wallet; its art and metadata JSON live at `uri` (e.g. Arweave).
//! * `claim_rewards` lets whoever holds the NFT withdraw the trading fees the locked
//!   liquidity has earned, at any time, including during the lock. Only the fee growth is
//!   withdrawn; the locked principal is never touched.
//! * `unlock` (only once `unlock_at` has passed) sends every LP token in the vault to the
//!   NFT holder, burns the NFT (its rent goes back to the holder) and closes the lock.
//!
//! There is no other way to move the LP: no admin, no early exit, no fee switch. Rights
//! follow the NFT, so selling or transferring it sells the fees and the LP with it.
//!
//! How fees are measured: in a constant-product pool, swaps can only grow
//! sqrt(reserve0 * reserve1), and only through trading fees. Deposits and withdrawals keep
//! sqrt(k) per LP token unchanged. So the liquidity one LP token represents is
//! `sqrt(k) / lp_supply`, and it only goes up. At lock time we record the locked liquidity
//! (`principal`, in sqrt(k) units, rounded up). Later the locked LP is worth
//! `lp * sqrt(k) / lp_supply` (rounded down); the difference is fees, and exactly that many
//! LP tokens are withdrawn through XDEX to the NFT holder. What stays in the vault is always
//! worth at least `principal` (checked again after every claim).
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::metadata::{
    self, mpl_token_metadata::{types::DataV2, ID as METADATA_PROGRAM_ID}, BurnNft, CreateMasterEditionV3,
    CreateMetadataAccountsV3, Metadata,
};
use anchor_spl::token::{self, CloseAccount, Mint, MintTo, Token, TokenAccount, Transfer};

declare_id!("8N4E3ZHBiYRMia8Hs27J6f3b9QM8wiTYcMXukSq96Ejf");

#[cfg(feature = "testnet")]
pub const XDEX_PROGRAM_ID: Pubkey = pubkey!("7EEuq61z9VKdkUzj7G36xGd7ncyz8KBtUwAWVjypYQHf");
#[cfg(not(feature = "testnet"))]
pub const XDEX_PROGRAM_ID: Pubkey = pubkey!("sEsYH97wqmfnkzHedjNcw3zyJdPvUmsa9AixhS4b4fN");

pub const MEMO_PROGRAM_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_SYMBOL_LEN: usize = 10;
pub const MAX_URI_LEN: usize = 200;
pub const MAX_LOCK_DURATION: i64 = 315_360_000; // 10 years

/// Anchor discriminator of XDEX `withdraw` (verified against XDEX mainnet transactions).
const WITHDRAW_DISC: [u8; 8] = [0xb7, 0x12, 0x46, 0x9c, 0x94, 0x6d, 0xa1, 0x22];
/// Anchor discriminator of XDEX `PoolState` (sha256("account:PoolState")[..8]).
const POOL_DISC: [u8; 8] = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];
const POOL_LEN: usize = 637;
/// Pool status bit 1 = withdrawals paused.
const STATUS_WITHDRAW_PAUSED: u8 = 1 << 1;

#[program]
pub mod lp_lock_nft {
    use super::*;

    /// Lock `amount` LP tokens of an XDEX pool for `lock_duration` seconds and mint the
    /// 1-of-1 lock NFT to `owner`.
    pub fn lock_lp(
        ctx: Context<LockLp>,
        amount: u64,
        lock_duration: i64,
        nft_name: String,
        nft_symbol: String,
        nft_uri: String,
    ) -> Result<()> {
        require!(amount > 0, LockError::ZeroAmount);
        require!(lock_duration > 0, LockError::InvalidDuration);
        require!(lock_duration <= MAX_LOCK_DURATION, LockError::DurationTooLong);
        require!(nft_name.len() <= MAX_NAME_LEN, LockError::NameTooLong);
        require!(nft_symbol.len() <= MAX_SYMBOL_LEN, LockError::SymbolTooLong);
        require!(nft_uri.len() <= MAX_URI_LEN, LockError::UriTooLong);

        let a = &ctx.accounts;
        let pool = PoolView::read(&a.pool)?;
        require_keys_eq!(pool.lp_mint, a.lp_mint.key(), LockError::WrongPoolAccount);
        let (sqrt_k, supply) = pool.liquidity(&a.token_0_vault, &a.token_1_vault)?;
        // Principal in sqrt(k) units, rounded up so fees can never dip into it.
        let principal = mul_div_ceil(amount as u128, sqrt_k, supply)?;
        require!(principal > 0, LockError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                a.token_program.to_account_info(),
                Transfer {
                    from: a.owner_lp.to_account_info(),
                    to: a.lp_vault.to_account_info(),
                    authority: a.owner.to_account_info(),
                },
            ),
            amount,
        )?;

        let auth_seeds: &[&[u8]] = &[b"nft_authority", &[ctx.bumps.nft_authority]];
        let signer: &[&[&[u8]]] = &[auth_seeds];
        token::mint_to(
            CpiContext::new_with_signer(
                a.token_program.to_account_info(),
                MintTo {
                    mint: a.nft_mint.to_account_info(),
                    to: a.owner_nft.to_account_info(),
                    authority: a.nft_authority.to_account_info(),
                },
                signer,
            ),
            1,
        )?;
        metadata::create_metadata_accounts_v3(
            CpiContext::new_with_signer(
                a.metadata_program.to_account_info(),
                CreateMetadataAccountsV3 {
                    metadata: a.metadata.to_account_info(),
                    mint: a.nft_mint.to_account_info(),
                    mint_authority: a.nft_authority.to_account_info(),
                    update_authority: a.nft_authority.to_account_info(),
                    payer: a.owner.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                    rent: a.rent.to_account_info(),
                },
                signer,
            ),
            DataV2 {
                name: nft_name,
                symbol: nft_symbol,
                uri: nft_uri,
                seller_fee_basis_points: 0,
                creators: None,
                collection: None,
                uses: None,
            },
            false, // immutable: the NFT always describes the lock it was minted for
            true,
            None,
        )?;
        // Max supply 0: no prints. Metaplex takes over the mint and freeze authority, so no
        // second NFT for this lock can ever be minted.
        metadata::create_master_edition_v3(
            CpiContext::new_with_signer(
                a.metadata_program.to_account_info(),
                CreateMasterEditionV3 {
                    edition: a.master_edition.to_account_info(),
                    mint: a.nft_mint.to_account_info(),
                    update_authority: a.nft_authority.to_account_info(),
                    mint_authority: a.nft_authority.to_account_info(),
                    payer: a.owner.to_account_info(),
                    metadata: a.metadata.to_account_info(),
                    token_program: a.token_program.to_account_info(),
                    system_program: a.system_program.to_account_info(),
                    rent: a.rent.to_account_info(),
                },
                signer,
            ),
            Some(0),
        )?;

        let now = Clock::get()?.unix_timestamp;
        let unlock_at = now.checked_add(lock_duration).ok_or(LockError::MathOverflow)?;
        let lock = &mut ctx.accounts.lock;
        lock.nft_mint = ctx.accounts.nft_mint.key();
        lock.pool = ctx.accounts.pool.key();
        lock.lp_mint = ctx.accounts.lp_mint.key();
        lock.locker = ctx.accounts.owner.key();
        lock.locked_lp = amount;
        lock.principal = principal;
        lock.fee_lp_claimed = 0;
        lock.locked_at = now;
        lock.unlock_at = unlock_at;
        lock.bump = ctx.bumps.lock;
        lock.vault_bump = ctx.bumps.lp_vault;

        emit!(Locked {
            lock: lock.key(),
            nft_mint: lock.nft_mint,
            pool: lock.pool,
            locker: lock.locker,
            lp_amount: amount,
            principal,
            unlock_at,
        });
        Ok(())
    }

    /// Withdraw the trading fees earned by the locked liquidity to the NFT holder's token
    /// accounts. Works during and after the lock. `minimum_token_0/1` guard against a
    /// manipulated pool ratio.
    pub fn claim_rewards(ctx: Context<ClaimRewards>, minimum_token_0: u64, minimum_token_1: u64) -> Result<()> {
        let a = &ctx.accounts;
        let pool = PoolView::read(&a.pool)?;
        require!(pool.status & STATUS_WITHDRAW_PAUSED == 0, LockError::PoolWithdrawPaused);
        require_keys_eq!(pool.lp_mint, a.lp_mint.key(), LockError::WrongPoolAccount);
        require_keys_eq!(pool.mint0, a.vault_0_mint.key(), LockError::WrongPoolAccount);
        require_keys_eq!(pool.mint1, a.vault_1_mint.key(), LockError::WrongPoolAccount);
        let (sqrt_k, supply) = pool.liquidity(&a.token_0_vault, &a.token_1_vault)?;

        let fee_lp = fee_lp(a.lp_vault.amount, a.lock.principal, sqrt_k, supply)?;
        require!(fee_lp > 0, LockError::NoRewardsYet);

        let nft_mint = a.lock.nft_mint;
        let seeds: &[&[u8]] = &[b"lock", nft_mint.as_ref(), &[a.lock.bump]];
        let mut data = Vec::with_capacity(32);
        data.extend_from_slice(&WITHDRAW_DISC);
        data.extend_from_slice(&fee_lp.to_le_bytes());
        data.extend_from_slice(&minimum_token_0.to_le_bytes());
        data.extend_from_slice(&minimum_token_1.to_le_bytes());
        let ix = Instruction {
            program_id: XDEX_PROGRAM_ID,
            accounts: vec![
                AccountMeta::new_readonly(a.lock.key(), true),
                AccountMeta::new_readonly(a.xdex_authority.key(), false),
                AccountMeta::new(a.pool.key(), false),
                AccountMeta::new(a.lp_vault.key(), false),
                AccountMeta::new(a.holder_token_0.key(), false),
                AccountMeta::new(a.holder_token_1.key(), false),
                AccountMeta::new(a.token_0_vault.key(), false),
                AccountMeta::new(a.token_1_vault.key(), false),
                AccountMeta::new_readonly(a.token_program.key(), false),
                AccountMeta::new_readonly(a.token_2022_program.key(), false),
                AccountMeta::new_readonly(a.vault_0_mint.key(), false),
                AccountMeta::new_readonly(a.vault_1_mint.key(), false),
                AccountMeta::new(a.lp_mint.key(), false),
                AccountMeta::new_readonly(a.memo_program.key(), false),
            ],
            data,
        };
        invoke_signed(
            &ix,
            &[
                a.lock.to_account_info(),
                a.xdex_authority.to_account_info(),
                a.pool.to_account_info(),
                a.lp_vault.to_account_info(),
                a.holder_token_0.to_account_info(),
                a.holder_token_1.to_account_info(),
                a.token_0_vault.to_account_info(),
                a.token_1_vault.to_account_info(),
                a.token_program.to_account_info(),
                a.token_2022_program.to_account_info(),
                a.vault_0_mint.to_account_info(),
                a.vault_1_mint.to_account_info(),
                a.lp_mint.to_account_info(),
                a.memo_program.to_account_info(),
                a.xdex_program.to_account_info(),
            ],
            &[seeds],
        )?;

        // Defence in depth: what remains must still cover the principal.
        let vault = &mut ctx.accounts.lp_vault;
        vault.reload()?;
        let pool_after = PoolView::read(&ctx.accounts.pool)?;
        let (sqrt_k_after, supply_after) =
            pool_after.liquidity(&ctx.accounts.token_0_vault, &ctx.accounts.token_1_vault)?;
        let remaining = mul_div_floor(vault.amount as u128, sqrt_k_after, supply_after)?;
        require!(remaining >= ctx.accounts.lock.principal, LockError::PrincipalViolated);

        let lock = &mut ctx.accounts.lock;
        lock.fee_lp_claimed = lock.fee_lp_claimed.checked_add(fee_lp).ok_or(LockError::MathOverflow)?;
        emit!(RewardsClaimed {
            lock: lock.key(),
            holder: ctx.accounts.holder.key(),
            fee_lp,
            remaining_lp: ctx.accounts.lp_vault.amount,
        });
        Ok(())
    }

    /// After the lock ends: send every LP token in the vault to the NFT holder, burn the
    /// NFT and close the lock and vault (all rent goes to the holder).
    pub fn unlock(ctx: Context<Unlock>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ctx.accounts.lock.unlock_at, LockError::StillLocked);
        let a = &ctx.accounts;
        let nft_mint = a.lock.nft_mint;
        let seeds: &[&[u8]] = &[b"lock", nft_mint.as_ref(), &[a.lock.bump]];
        let amount = a.lp_vault.amount;
        if amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    a.token_program.to_account_info(),
                    Transfer {
                        from: a.lp_vault.to_account_info(),
                        to: a.holder_lp.to_account_info(),
                        authority: a.lock.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
            )?;
        }
        token::close_account(CpiContext::new_with_signer(
            a.token_program.to_account_info(),
            CloseAccount {
                account: a.lp_vault.to_account_info(),
                destination: a.holder.to_account_info(),
                authority: a.lock.to_account_info(),
            },
            &[seeds],
        ))?;
        // Burns the NFT and closes its token, metadata and edition accounts to the holder.
        metadata::burn_nft(
            CpiContext::new(
                a.metadata_program.to_account_info(),
                BurnNft {
                    metadata: a.metadata.to_account_info(),
                    owner: a.holder.to_account_info(),
                    mint: a.nft_mint.to_account_info(),
                    token: a.holder_nft.to_account_info(),
                    edition: a.master_edition.to_account_info(),
                    spl_token: a.token_program.to_account_info(),
                },
            ),
            None,
        )?;
        emit!(Unlocked { lock: a.lock.key(), holder: a.holder.key(), lp_amount: amount });
        Ok(()) // `close = holder` closes the lock account
    }
}

/// LP tokens worth of fees: locked value minus principal, converted back to LP.
pub fn fee_lp(locked_lp: u64, principal: u128, sqrt_k: u128, supply: u128) -> Result<u64> {
    let value = mul_div_floor(locked_lp as u128, sqrt_k, supply)?;
    if value <= principal {
        return Ok(0);
    }
    let lp = mul_div_floor(value - principal, supply, sqrt_k)?;
    u64::try_from(lp).map_err(|_| error!(LockError::MathOverflow))
}

fn mul_div_floor(a: u128, b: u128, c: u128) -> Result<u128> {
    require!(c > 0, LockError::MathOverflow);
    Ok(a.checked_mul(b).ok_or(LockError::MathOverflow)? / c)
}

fn mul_div_ceil(a: u128, b: u128, c: u128) -> Result<u128> {
    require!(c > 0, LockError::MathOverflow);
    let p = a.checked_mul(b).ok_or(LockError::MathOverflow)?;
    Ok(p / c + u128::from(p % c != 0))
}

pub fn isqrt(n: u128) -> u128 {
    if n < 2 {
        return n;
    }
    let mut x = 1u128 << ((128 - n.leading_zeros()).div_ceil(2));
    loop {
        let y = (x + n / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// The parts of an XDEX PoolState this program needs (layout verified against X1 pools).
struct PoolView {
    vault0: Pubkey,
    vault1: Pubkey,
    lp_mint: Pubkey,
    mint0: Pubkey,
    mint1: Pubkey,
    status: u8,
    lp_supply: u64,
    protocol_fees: [u64; 2],
    fund_fees: [u64; 2],
}

impl PoolView {
    fn read(acc: &AccountInfo) -> Result<Self> {
        require_keys_eq!(*acc.owner, XDEX_PROGRAM_ID, LockError::WrongPoolAccount);
        let d = acc.try_borrow_data()?;
        require!(d.len() == POOL_LEN, LockError::WrongPoolAccount);
        require!(d[..8] == POOL_DISC, LockError::WrongPoolAccount);
        let key = |i: usize| Pubkey::new_from_array(d[8 + i * 32..40 + i * 32].try_into().unwrap());
        let u64_at = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
        Ok(Self {
            vault0: key(2),
            vault1: key(3),
            lp_mint: key(4),
            mint0: key(5),
            mint1: key(6),
            status: d[329],
            lp_supply: u64_at(333),
            protocol_fees: [u64_at(341), u64_at(349)],
            fund_fees: [u64_at(357), u64_at(365)],
        })
    }

    /// (sqrt(reserve0 * reserve1), pool LP supply). Reserves exclude protocol and fund
    /// fees, exactly as the pool itself prices deposits and withdrawals.
    fn liquidity(&self, v0: &AccountInfo, v1: &AccountInfo) -> Result<(u128, u128)> {
        require_keys_eq!(self.vault0, v0.key(), LockError::WrongPoolAccount);
        require_keys_eq!(self.vault1, v1.key(), LockError::WrongPoolAccount);
        let r0 = token_amount(v0)?
            .checked_sub(self.protocol_fees[0] + self.fund_fees[0])
            .ok_or(LockError::MathOverflow)?;
        let r1 = token_amount(v1)?
            .checked_sub(self.protocol_fees[1] + self.fund_fees[1])
            .ok_or(LockError::MathOverflow)?;
        require!(r0 > 0 && r1 > 0 && self.lp_supply > 0, LockError::EmptyPool);
        Ok((isqrt(r0 as u128 * r1 as u128), self.lp_supply as u128))
    }
}

fn token_amount(acc: &AccountInfo) -> Result<u64> {
    require!(
        *acc.owner == anchor_spl::token::ID || *acc.owner == anchor_spl::token_2022::ID,
        LockError::WrongPoolAccount
    );
    let d = acc.try_borrow_data()?;
    require!(d.len() >= 72, LockError::WrongPoolAccount);
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

#[account]
#[derive(InitSpace)]
pub struct Lock {
    pub nft_mint: Pubkey,
    pub pool: Pubkey,
    pub lp_mint: Pubkey,
    /// Wallet that created the lock (the NFT may have moved since).
    pub locker: Pubkey,
    pub locked_lp: u64,
    /// Locked liquidity in sqrt(k) units; never withdrawn before `unlock_at`.
    pub principal: u128,
    pub fee_lp_claimed: u64,
    pub locked_at: i64,
    /// Unix seconds after which the NFT holder may `unlock`.
    pub unlock_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(Accounts)]
pub struct LockLp<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: owner, size and discriminator checked in PoolView::read.
    pub pool: UncheckedAccount<'info>,
    /// CHECK: must equal the pool's token 0 vault (checked in PoolView::liquidity).
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK: must equal the pool's token 1 vault (checked in PoolView::liquidity).
    pub token_1_vault: UncheckedAccount<'info>,
    pub lp_mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = lp_mint, token::authority = owner)]
    pub owner_lp: Box<Account<'info, TokenAccount>>,
    /// CHECK: program-wide PDA that mints every lock NFT and is their metadata update
    /// authority. Only this program can sign for it, and it has no update instruction.
    #[account(seeds = [b"nft_authority"], bump)]
    pub nft_authority: UncheckedAccount<'info>,
    #[account(
        init, payer = owner,
        mint::decimals = 0, mint::authority = nft_authority, mint::freeze_authority = nft_authority,
    )]
    pub nft_mint: Box<Account<'info, Mint>>,
    #[account(init, payer = owner, associated_token::mint = nft_mint, associated_token::authority = owner)]
    pub owner_nft: Box<Account<'info, TokenAccount>>,
    #[account(init, payer = owner, space = 8 + Lock::INIT_SPACE, seeds = [b"lock", nft_mint.key().as_ref()], bump)]
    pub lock: Box<Account<'info, Lock>>,
    #[account(
        init, payer = owner, seeds = [b"vault", lock.key().as_ref()], bump,
        token::mint = lp_mint, token::authority = lock,
    )]
    pub lp_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: Metaplex metadata PDA of the NFT; created by the Metaplex CPI.
    #[account(
        mut,
        seeds = [b"metadata", METADATA_PROGRAM_ID.as_ref(), nft_mint.key().as_ref()],
        bump, seeds::program = METADATA_PROGRAM_ID,
    )]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: Metaplex master edition PDA of the NFT; created by the Metaplex CPI.
    #[account(
        mut,
        seeds = [b"metadata", METADATA_PROGRAM_ID.as_ref(), nft_mint.key().as_ref(), b"edition"],
        bump, seeds::program = METADATA_PROGRAM_ID,
    )]
    pub master_edition: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub metadata_program: Program<'info, Metadata>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(mut, seeds = [b"lock", lock.nft_mint.as_ref()], bump = lock.bump)]
    pub lock: Box<Account<'info, Lock>>,
    #[account(
        token::mint = lock.nft_mint, token::authority = holder,
        constraint = holder_nft.amount == 1 @ LockError::NotNftHolder,
    )]
    pub holder_nft: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"vault", lock.key().as_ref()], bump = lock.vault_bump)]
    pub lp_vault: Box<Account<'info, TokenAccount>>,
    /// CHECK: must be the locked pool; XDEX checks the rest.
    #[account(mut, address = lock.pool @ LockError::WrongPoolAccount)]
    pub pool: UncheckedAccount<'info>,
    /// CHECK: XDEX vault/LP authority PDA; XDEX verifies it.
    pub xdex_authority: UncheckedAccount<'info>,
    /// CHECK: where token 0 rewards go; XDEX checks the mint.
    #[account(mut)]
    pub holder_token_0: UncheckedAccount<'info>,
    /// CHECK: where token 1 rewards go; XDEX checks the mint.
    #[account(mut)]
    pub holder_token_1: UncheckedAccount<'info>,
    /// CHECK: checked against the pool.
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK: checked against the pool.
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    /// CHECK: SPL Token-2022 (XDEX needs it for Token-2022 pool sides).
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_2022_program: UncheckedAccount<'info>,
    /// CHECK: checked against the pool.
    pub vault_0_mint: UncheckedAccount<'info>,
    /// CHECK: checked against the pool.
    pub vault_1_mint: UncheckedAccount<'info>,
    /// CHECK: must be the locked LP mint.
    #[account(mut, address = lock.lp_mint @ LockError::WrongPoolAccount)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: SPL Memo program, required by XDEX withdraw.
    #[account(address = MEMO_PROGRAM_ID)]
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: the XDEX program this build targets.
    #[account(address = XDEX_PROGRAM_ID)]
    pub xdex_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Unlock<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(mut, close = holder, seeds = [b"lock", lock.nft_mint.as_ref()], bump = lock.bump)]
    pub lock: Box<Account<'info, Lock>>,
    #[account(mut, address = lock.nft_mint @ LockError::NotNftHolder)]
    pub nft_mint: Box<Account<'info, Mint>>,
    #[account(
        mut, token::mint = lock.nft_mint, token::authority = holder,
        constraint = holder_nft.amount == 1 @ LockError::NotNftHolder,
    )]
    pub holder_nft: Box<Account<'info, TokenAccount>>,
    #[account(mut, seeds = [b"vault", lock.key().as_ref()], bump = lock.vault_bump)]
    pub lp_vault: Box<Account<'info, TokenAccount>>,
    #[account(mut, token::mint = lock.lp_mint, token::authority = holder)]
    pub holder_lp: Box<Account<'info, TokenAccount>>,
    /// CHECK: Metaplex metadata PDA of the NFT; Metaplex checks it when burning.
    #[account(
        mut,
        seeds = [b"metadata", METADATA_PROGRAM_ID.as_ref(), lock.nft_mint.as_ref()],
        bump, seeds::program = METADATA_PROGRAM_ID,
    )]
    pub metadata: UncheckedAccount<'info>,
    /// CHECK: Metaplex master edition PDA of the NFT; Metaplex checks it when burning.
    #[account(
        mut,
        seeds = [b"metadata", METADATA_PROGRAM_ID.as_ref(), lock.nft_mint.as_ref(), b"edition"],
        bump, seeds::program = METADATA_PROGRAM_ID,
    )]
    pub master_edition: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub metadata_program: Program<'info, Metadata>,
}

#[event]
pub struct Locked {
    pub lock: Pubkey,
    pub nft_mint: Pubkey,
    pub pool: Pubkey,
    pub locker: Pubkey,
    pub lp_amount: u64,
    pub principal: u128,
    pub unlock_at: i64,
}

#[event]
pub struct RewardsClaimed {
    pub lock: Pubkey,
    pub holder: Pubkey,
    pub fee_lp: u64,
    pub remaining_lp: u64,
}

#[event]
pub struct Unlocked {
    pub lock: Pubkey,
    pub holder: Pubkey,
    pub lp_amount: u64,
}

#[error_code]
pub enum LockError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Lock duration must be greater than zero")]
    InvalidDuration,
    #[msg("Lock duration exceeds the 10-year maximum")]
    DurationTooLong,
    #[msg("NFT name too long (32 max)")]
    NameTooLong,
    #[msg("NFT symbol too long (10 max)")]
    SymbolTooLong,
    #[msg("Metadata URI too long (200 max)")]
    UriTooLong,
    #[msg("Account does not belong to this XDEX pool")]
    WrongPoolAccount,
    #[msg("Pool has no liquidity")]
    EmptyPool,
    #[msg("Signer does not hold the lock NFT")]
    NotNftHolder,
    #[msg("No trading fees to claim yet")]
    NoRewardsYet,
    #[msg("Pool withdrawals are paused")]
    PoolWithdrawPaused,
    #[msg("Claim would touch the locked principal")]
    PrincipalViolated,
    #[msg("This lock has not reached its unlock time")]
    StillLocked,
    #[msg("Math overflow")]
    MathOverflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isqrt_is_exact_floor() {
        for n in [0u128, 1, 2, 3, 4, 15, 16, 17, 1 << 64, u64::MAX as u128 * u64::MAX as u128, u128::MAX] {
            let r = isqrt(n);
            assert!(r * r <= n, "{n}");
            assert!((r + 1).checked_mul(r + 1).map_or(true, |s| s > n), "{n}");
        }
    }

    #[test]
    fn no_rewards_until_liquidity_per_lp_grows() {
        let (sqrt_k, supply) = (1_000_000u128, 1_000u128);
        let principal = mul_div_ceil(100, sqrt_k, supply).unwrap();
        assert_eq!(fee_lp(100, principal, sqrt_k, supply).unwrap(), 0);
        // Deposits/withdrawals scale sqrt_k and supply together: still no rewards.
        assert_eq!(fee_lp(100, principal, sqrt_k * 3, supply * 3).unwrap(), 0);
    }

    #[test]
    fn rewards_are_only_the_growth_and_principal_is_kept() {
        let (sqrt_k, supply) = (1_000_000_000u128, 1_000_000u128);
        let lp = 100_000u64;
        let principal = mul_div_ceil(lp as u128, sqrt_k, supply).unwrap();
        // Trading fees grow sqrt(k) by 1%.
        let grown = sqrt_k * 101 / 100;
        let fee = fee_lp(lp, principal, grown, supply).unwrap();
        assert!(fee > 0 && fee < lp / 100 + 1);
        let remaining_value = mul_div_floor((lp - fee) as u128, grown, supply).unwrap();
        assert!(remaining_value >= principal);
        // Claiming again right away yields nothing.
        assert_eq!(fee_lp(lp - fee, principal, grown, supply).unwrap(), 0);
    }
}
