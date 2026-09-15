import { SlashCommandBuilder } from 'discord.js';
import { successEmbed, warningEmbed } from '../../utils/embeds.js';
import { getEconomyData, setEconomyData } from '../../utils/economy.js';
import { withErrorHandling, createError, ErrorTypes } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';

const COINFLIP_COOLDOWN = 2 * 60 * 1000; // 2 minutes
const WIN_PAYOUT = 2.0;
const HOUSE_EDGE = 0.02; // true odds are 50/50; this shaves a small house edge, matching /gamble's < 50% base

export default {
    data: new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription('Bet on a coin flip')
        .addIntegerOption(option =>
            option
                .setName('amount')
                .setDescription('Amount of cash to bet')
                .setRequired(true)
                .setMinValue(1)
        )
        .addStringOption(option =>
            option
                .setName('side')
                .setDescription('Which side you think it lands on')
                .setRequired(true)
                .addChoices(
                    { name: 'Heads', value: 'heads' },
                    { name: 'Tails', value: 'tails' },
                )
        ),

    execute: withErrorHandling(async (interaction, config, client) => {
        const deferred = await InteractionHelper.safeDefer(interaction);
        if (!deferred) return;

        const userId = interaction.user.id;
        const guildId = interaction.guildId;
        const betAmount = interaction.options.getInteger('amount');
        const chosenSide = interaction.options.getString('side');
        const now = Date.now();

        const userData = await getEconomyData(client, guildId, userId);
        const lastCoinflip = userData.lastCoinflip || 0;

        if (now < lastCoinflip + COINFLIP_COOLDOWN) {
            const remaining = lastCoinflip + COINFLIP_COOLDOWN - now;
            const minutes = Math.floor(remaining / (1000 * 60));
            const seconds = Math.floor((remaining % (1000 * 60)) / 1000);

            throw createError(
                'Coinflip cooldown active',
                ErrorTypes.RATE_LIMIT,
                `You need to cool down before flipping again. Wait **${minutes}m ${seconds}s**.`,
                { remaining, cooldownType: 'coinflip' }
            );
        }

        if (userData.wallet < betAmount) {
            throw createError(
                'Insufficient cash for coinflip',
                ErrorTypes.VALIDATION,
                `You only have $${userData.wallet.toLocaleString()} cash, but you are trying to bet $${betAmount.toLocaleString()}.`,
                { required: betAmount, current: userData.wallet }
            );
        }

        const landedOnChosen = Math.random() < (0.5 - HOUSE_EDGE);
        const result = landedOnChosen ? chosenSide : (chosenSide === 'heads' ? 'tails' : 'heads');
        const resultEmoji = result === 'heads' ? '🪙 Heads' : '🪙 Tails';

        let cashChange;
        let resultEmbed;

        if (landedOnChosen) {
            const amountWon = Math.floor(betAmount * WIN_PAYOUT);
            cashChange = amountWon - betAmount;
            resultEmbed = successEmbed(
                '🎉 You Won!',
                `The coin landed on **${resultEmoji}**, just like you called it! Your **$${betAmount.toLocaleString()}** bet paid out **$${amountWon.toLocaleString()}**!`
            );
        } else {
            cashChange = -betAmount;
            resultEmbed = warningEmbed(
                '💔 You Lost...',
                `The coin landed on **${resultEmoji}**. You called ${chosenSide}, so you lost your **$${betAmount.toLocaleString()}** bet.`
            );
        }

        userData.wallet = (userData.wallet || 0) + cashChange;
        userData.lastCoinflip = now;
        await setEconomyData(client, guildId, userId, userData);

        resultEmbed.addFields({
            name: 'New Cash Balance',
            value: `$${userData.wallet.toLocaleString()}`,
            inline: true,
        });

        await InteractionHelper.safeEditReply(interaction, { embeds: [resultEmbed] });
    }, { command: 'coinflip' })
};
