import { router } from 'expo-router';
import { useEffect } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { Spacing } from '@/constants/theme';
import { Brand } from '@/components/cart/cart-styles';

/**
 * Paystack return landing route (`demolscakesmobile://checkout/result`).
 *
 * The website's mobile Paystack callback redirects here after verifying the
 * payment server-side. This screen performs NO verification and clears
 * nothing itself: the checkout screen's deep-link listener observes the same
 * return and drives `verifyAndFinalize` (server truth) there, so this route
 * only steps aside back to the stateful checkout screen, which shows the
 * waiting indicator, the retry UI, or the success screen.
 *
 * Cold-start fallback (app was killed before the return): there is no
 * checkout underneath, so landing here goes to a fresh checkout instead. The
 * cart was never cleared without a verified PAID, and the paid order remains
 * in the customer's account history.
 */
export default function PaymentResultScreen() {
  useEffect(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/checkout');
  }, []);

  return (
    <View style={styles.screen}>
      <ActivityIndicator color={Brand.purple} />
      <Text style={styles.text}>Confirming your payment...</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.two,
    padding: Spacing.four,
    backgroundColor: Brand.white,
  },
  text: {
    fontSize: 15,
    fontWeight: '600',
    color: Brand.purpleDeep,
  },
});
