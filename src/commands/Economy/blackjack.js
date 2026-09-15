import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import { createEmbed, successEmbed, infoEmbed, warningEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const BLACKJACK_COOLDOWN = 3 * 60 * 1000; // 3 minutes
const NATURAL_BLACKJACK_PAYOUT = 2.5;     // payout multiplier for a natural blackjack
const WIN_PAYOUT = 2.0;                   // payout multiplier for a regular win
const ROUND_TIMEOUT = 60 * 1000;          // player has 60s per round to act

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) {
            deck.push({ suit, rank });
        }
    }
    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function cardValue(card) {
    if (card.rank === 'A') return 11;
    if (['K', 'Q', 'J'].includes(card.rank)) return 10;
    return parseInt(card.rank, 10);
}

function handValue(hand) {
    let total = hand.reduce((sum, card) => sum + cardValue(card), 0);
    let aces = hand.filter(card => card.rank === 'A').length;
    while (total > 21 && aces > 0) {
        total -= 10;
        aces -= 1;
    }
    return total;
}

function formatCard(card) {
    return `\`${card.rank}${card.suit}\``;
}

function formatHand(hand, hideFirst = false) {
    if (hideFirst) {
        return `\`🂠\` ${hand.slice(1).map(formatCard).join(' ')}`;
    }
    return hand.map(formatCard).join(' ');
}

function isBlackjack(hand) {
    return hand.length === 2 && handValue(hand) === 21;
}

function buildActionRow(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('bj_hit')
            .setLabel('Hit')
            .setStyle(ButtonStyle.Success)
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('bj_stand')
            .setLabel('Stand')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(disabled),
    );
}

function addHandFields(embed, playerHand, dealerHand, hideDealer) {
    return embed.addFields(
        {
            name: `Your Hand (${handValue(playerHand)})`,
            value: formatHand(playerHand),
            inline: false,
        },
        {
            name: hideDealer ? 'Dealer Hand (?)' : `Dealer Hand (${handValue(dealerHand)})`,
            value: formatHand(dealerHand, hideDealer),
            inline: false,
        },
    );
}

export default {
    data: new SlashCommandBuilder()
        .setName('blackjack')
        .setDescription('Play a round of blackjack against the dealer')
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Amount of cash to bet')
                .setRequired(true)
                .setMinValue(1)
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const betAmount = interaction.options.getInteger('amount');
        const now = Date.now();

        const userData = await getEconomyData(client, guildId, userId);
        const lastBlackjack = userData.lastBlackjack || 0;

        if (now < lastBlackjack + BLACKJACK_COOLDOWN) {
            const remaining = lastBlackjack + BLACKJACK_COOLDOWN - now;
            const minutes = Math.floor(remaining / (1000 * 60));
            const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

            throw createError(
                'Blackjack cooldown active',
                ErrorTypes.RATE_LIMIT,
                `You need to cool down before playing again. Wait **${minutes}m ${seconds}s**.`,
                { remaining, cooldownType: 'blackjack' }
            );
        }

        if (userData.wallet < betAmount) {
            throw createError(
                'Insufficient cash for blackjack',
                ErrorTypes.VALIDATION,
                `You only have $${userData.wallet.toLocaleString()} cash, but you are trying to bet $${betAmount.toLocaleString()}.`,
                { required: betAmount, current: userData.wallet }
            );
        }

        // Lock in the cooldown right away so a round that crashes or times out
        // can't be replayed for free. Wallet stays untouched until the round settles.
        userData.lastBlackjack = now;
        await setEconomyData(client, guildId, userId, userData);

        const deck = createDeck();
        const playerHand = [deck.pop(), deck.pop()];
        const dealerHand = [deck.pop(), deck.pop()];

        const settleRound = async (resultEmbed, cashChange, hideDealer = false) => {
            addHandFields(resultEmbed, playerHand, dealerHand, hideDealer);

            const freshData = await getEconomyData(client, guildId, userId);
            freshData.wallet = (freshData.wallet || 0) + cashChange;
            await setEconomyData(client, guildId, userId, freshData);

            resultEmbed.addFields({
                name: 'New Cash Balance',
                value: `$${freshData.wallet.toLocaleString()}`,
                inline: true,
            });

            return resultEmbed;
        };

        // Check for naturals before the player gets to act
        const playerBJ = isBlackjack(playerHand);
        const dealerBJ = isBlackjack(dealerHand);

        if (playerBJ || dealerBJ) {
            let resultEmbed;
            let cashChange;

            if (playerBJ && dealerBJ) {
                cashChange = 0;
                resultEmbed = warningEmbed(
                    '🤝 Push!',
                    `Both you and the dealer had blackjack. Your **$${betAmount.toLocaleString()}** bet was returned.`
                );
            } else if (playerBJ) {
                const amountWon = Math.floor(betAmount * NATURAL_BLACKJACK_PAYOUT);
                cashChange = amountWon - betAmount;
                resultEmbed = successEmbed(
                    '🎉 Blackjack!',
                    `You drew a natural blackjack! Your **$${betAmount.toLocaleString()}** bet paid out **$${amountWon.toLocaleString()}**!`
                );
            } else {
                cashChange = -betAmount;
                resultEmbed = warningEmbed(
                    '💔 Dealer Blackjack',
                    `The dealer had a natural blackjack. You lost your **$${betAmount.toLocaleString()}** bet.`
                );
            }

            await settleRound(resultEmbed, cashChange);
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [resultEmbed],
                components: [buildActionRow(true)],
            });
            return;
        }

        const gameEmbed = infoEmbed('🃏 Blackjack', `Bet: $${betAmount.toLocaleString()}`);
        addHandFields(gameEmbed, playerHand, dealerHand, true);

        await InteractionHelper.safeEditReply(interaction, { embeds: [gameEmbed], components: [buildActionRow()] });
        const message = await interaction.fetchReply();

        const collector = message.createMessageComponentCollector({
            componentType: ComponentType.Button,
            time: ROUND_TIMEOUT,
            filter: (i) => i.user.id === userId,
        });

        let settled = false;

        collector.on('collect', async (buttonInteraction) => {
            if (buttonInteraction.customId === 'bj_hit') {
                playerHand.push(deck.pop());
                const playerTotal = handValue(playerHand);

                if (playerTotal > 21) {
                    settled = true;
                    collector.stop('bust');

                    const resultEmbed = warningEmbed(
                        '💥 Bust!',
                        `You went over 21 and lost your **$${betAmount.toLocaleString()}** bet.`
                    );
                    await settleRound(resultEmbed, -betAmount);
                    await buttonInteraction.update({ embeds: [resultEmbed], components: [buildActionRow(true)] });
                    return;
                }

                const updatedEmbed = infoEmbed('🃏 Blackjack', `Bet: $${betAmount.toLocaleString()}`);
                addHandFields(updatedEmbed, playerHand, dealerHand, true);
                await buttonInteraction.update({ embeds: [updatedEmbed], components: [buildActionRow()] });
                return;
            }

            if (buttonInteraction.customId === 'bj_stand') {
                settled = true;
                collector.stop('stand');

                while (handValue(dealerHand) < 17) {
                    dealerHand.push(deck.pop());
                }

                const playerTotal = handValue(playerHand);
                const dealerTotal = handValue(dealerHand);

                let resultEmbed;
                let cashChange;

                if (dealerTotal > 21 || playerTotal > dealerTotal) {
                    const amountWon = Math.floor(betAmount * WIN_PAYOUT);
                    cashChange = amountWon - betAmount;
                    resultEmbed = successEmbed(
                        '🎉 You Won!',
                        dealerTotal > 21
                            ? `The dealer busted with **${dealerTotal}**! You won **$${amountWon.toLocaleString()}**!`
                            : `You beat the dealer, **${playerTotal}** to **${dealerTotal}**! You won **$${amountWon.toLocaleString()}**!`
                    );
                } else if (playerTotal === dealerTotal) {
                    cashChange = 0;
                    resultEmbed = warningEmbed(
                        '🤝 Push!',
                        `Both you and the dealer had **${playerTotal}**. Your **$${betAmount.toLocaleString()}** bet was returned.`
                    );
                } else {
                    cashChange = -betAmount;
                    resultEmbed = warningEmbed(
                        '💔 You Lost...',
                        `The dealer beat you, **${dealerTotal}** to **${playerTotal}**. You lost your **$${betAmount.toLocaleString()}** bet.`
                    );
                }

                await settleRound(resultEmbed, cashChange);
                await buttonInteraction.update({ embeds: [resultEmbed], components: [buildActionRow(true)] });
            }
        });

        collector.on('end', async (_collected, reason) => {
            if (settled || reason !== 'time') return;

            // Player didn't act in time — auto-stand on their current hand.
            while (handValue(dealerHand) < 17) {
                dealerHand.push(deck.pop());
            }

            const playerTotal = handValue(playerHand);
            const dealerTotal = handValue(dealerHand);

            let resultEmbed;
            let cashChange;

            if (dealerTotal > 21 || playerTotal > dealerTotal) {
                const amountWon = Math.floor(betAmount * WIN_PAYOUT);
                cashChange = amountWon - betAmount;
                resultEmbed = successEmbed(
                    "⏰ Time's Up — You Won!",
                    `You didn't respond in time, so we auto-stood on your **${playerTotal}**. You won **$${amountWon.toLocaleString()}**!`
                );
            } else if (playerTotal === dealerTotal) {
                cashChange = 0;
                resultEmbed = warningEmbed(
                    "⏰ Time's Up — Push!",
                    `You didn't respond in time. Your **$${betAmount.toLocaleString()}** bet was returned.`
                );
            } else {
                cashChange = -betAmount;
                resultEmbed = warningEmbed(
                    "⏰ Time's Up — You Lost",
                    `You didn't respond in time, so we auto-stood on your **${playerTotal}**. You lost your **$${betAmount.toLocaleString()}** bet.`
                );
            }

            await settleRound(resultEmbed, cashChange);
            await InteractionHelper.safeEditReply(interaction, {
                embeds: [resultEmbed],
                components: [buildActionRow(true)],
            });
        });
    }, { command: 'blackjack' })
};
