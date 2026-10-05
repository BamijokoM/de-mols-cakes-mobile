import { router } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { openAuthSessionAsync } from 'expo-web-browser';

import { BottomTabInset, Spacing } from '@/constants/theme';
import {
  Brand,
  TouchTarget,
  styles as cartStyles,
} from '@/components/cart/cart-styles';
import { useAuth } from '@/hooks/use-auth';
import { useCart, type GuestCartLine } from '@/hooks/use-cart';
import { useTheme } from '@/hooks/use-theme';
import { getSupabaseClient } from '@/lib/supabase/client';
import { formatPrice } from '@/lib/format';
import { describeSelection, isFreeTextOption } from '@/lib/pricing';

/**
 * Mobile checkout.
 *
 * The screen only COLLECTS and VALIDATES. Every price is recomputed on the
 * server — `validateCheckoutInput` strips the payload down to product ids,
 * option ids, quantities and free text, and `startPayment` re-prices each line
 * from the catalogue before an order or a Paystack transaction is created.
 * Nothing monetary is calculated or trusted here; the subtotal shown is the
 * display value already held in cart state and is never sent.
 *
 * The request mirrors `POST /api/mobile/checkout` exactly, including the
 * snake_case line shape and the `customer.*` / `delivery.*` / `lines` field
 * error keys, so a server rejection maps straight back onto the right input.
 * No Paystack key or token is handled by the app — only the JSON response.
 *
 * Payment flow: the API returns ONE order with an `authorizationUrl`, which is
 * opened in the system browser. Paystack returns to the website's mobile
 * callback (which verifies with the existing server logic), and the website
 * deep-links back into the app. The cart is cleared ONLY after
 * `GET /api/mobile/orders/[id]/payment` confirms the database row is PAID —
 * the deep link alone is only ever a hint, never proof.
 */

/**
 * Where `POST /api/mobile/checkout` lives.
 *
 * `EXPO_PUBLIC_SITE_URL` is inlined at build time and must be the production
 * website origin with no trailing slash; when it is missing or empty the
 * request falls back to the production URL so checkout always targets a live
 * server instead of `undefined/api/...`.
 */
const SITE_ORIGIN = (process.env.EXPO_PUBLIC_SITE_URL ?? '').trim().replace(/\/+$/, '');
const SITE_BASE = SITE_ORIGIN || 'https://de-mols-cakes.vercel.app';
const CHECKOUT_URL = `${SITE_BASE}/api/mobile/checkout`;

/** Server-truth payment check for one order. PAID here gates the cart clear. */
const paymentStatusUrl = (orderId: string) =>
  `${SITE_BASE}/api/mobile/orders/${encodeURIComponent(orderId)}/payment`;

/**
 * Where Paystack sends the customer back (via the website's mobile callback).
 * The scheme matches `expo.scheme` in `app.json`; the path needs no screen —
 * the redirect URL is captured from the auth-session result and verified
 * against the server before anything else happens.
 */
const PAYMENT_RETURN_URL = 'demolscakesmobile://checkout/result';

/** Same patterns the server validates against (`src/lib/orders.ts`). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Text colours for the checkout inputs. Every field sits on the white section
 * card (`#FFFFFF` / `#FBF8FE`) in BOTH themes, so typed text, placeholders and
 * validation messages use fixed light-surface colours — never `theme.text`,
 * which is white in dark mode and invisible on these light inputs.
 */
const INPUT_INK = '#241233';
const INPUT_PLACEHOLDER = '#6B6478';
const INPUT_ERROR = '#D10654';

/** Mirrors `delivery.methods` in the website's `src/lib/site.ts`. */
const DELIVERY_METHODS = [
  { id: 'pickup', label: 'Pickup' },
  { id: 'delivery', label: 'Delivery' },
] as const;

type DeliveryMethodId = (typeof DELIVERY_METHODS)[number]['id'];

type CheckoutLine = {
  product_id: string;
  quantity: number;
  option_ids: string[];
  option_quantities: Record<string, number>;
  inscription?: string;
};

type SuccessState = {
  orderNumber: string;
  reference: string;
  orderId: string | null;
  authorizationUrl: string | null;
};

/**
 * The single order created by `POST /api/mobile/checkout`, awaiting payment.
 * Kept in state so a retry reopens Paystack for THIS order instead of
 * creating a second one — exactly one order exists per submit.
 */
type PendingOrder = {
  orderId: string;
  reference: string;
  orderNumber: string;
  authorizationUrl: string;
};

/** Customer-safe wording per deep-link failure hint from the callback. */
const PAYMENT_HINT_MESSAGES: Record<string, string> = {
  not_paid: "Your payment didn't go through, so nothing has been charged.",
  amount_mismatch:
    "The amount received didn't match your order total, so we haven't confirmed this order. Please call us and we'll sort it out with you.",
  verification_failed:
    "We couldn't confirm your payment just now. Please try again, or call us and we'll check the order for you.",
  not_found:
    "We couldn't match that payment to an order. If you were charged, please call us with your receipt and we'll put it right.",
};

type FieldErrors = Record<string, string>;

/**
 * Maps one cart line onto the API's `CheckoutLineInput`.
 *
 * The two line sources carry the inscription differently: a line just added on
 * this device keeps it in `line.inscription`, while a line read back from the
 * database has it folded into `selections` as a null-id free-text entry (that
 * folding is what keeps `line_key` identical across clients). Both are read
 * here, and null option ids are dropped so only real `product_option` ids are
 * ever submitted.
 */
function toCheckoutLine(line: GuestCartLine): CheckoutLine {
  const freeText = line.selections.find((selection) =>
    isFreeTextOption(selection.option_type)
  );

  const optionIds: string[] = [];
  const optionQuantities: Record<string, number> = {};

  for (const selection of line.selections) {
    if (!selection.option_id) continue;
    optionIds.push(selection.option_id);
    // Only per-unit options (flower stems) carry a count; the server re-reads
    // every price from the catalogue regardless.
    if (selection.quantity !== undefined) {
      optionQuantities[selection.option_id] = selection.quantity;
    }
  }

  const inscription = (line.inscription || freeText?.name || '').trim();

  return {
    product_id: line.productId,
    quantity: line.quantity,
    option_ids: optionIds,
    option_quantities: optionQuantities,
    ...(inscription ? { inscription } : {}),
  };
}

/**
 * Client-side mirror of the server's validation, so the customer sees the
 * problem before a round trip. The server still re-validates — this only
 * shortens the feedback loop and can never relax the rules.
 */
function validateForm(input: {
  name: string;
  email: string;
  phone: string;
  method: DeliveryMethodId;
  address: string;
  city: string;
  state: string;
  date: string;
  notes: string;
}): FieldErrors {
  const errors: FieldErrors = {};

  if (input.name.trim().length < 2) {
    errors['customer.name'] = 'Please enter your full name.';
  }
  if (!EMAIL_PATTERN.test(input.email.trim())) {
    errors['customer.email'] = 'Please enter a valid email address.';
  }
  if (input.phone.replace(/\D/g, '').length < 7) {
    errors['customer.phone'] = 'Please enter a valid phone number.';
  }

  if (input.method !== 'pickup' && input.method !== 'delivery') {
    errors['delivery.method'] = 'Please choose pickup or delivery.';
  }
  if (input.method === 'delivery') {
    if (input.address.trim().length < 5) {
      errors['delivery.address'] = 'Please enter the delivery address.';
    }
    if (input.city.trim().length < 2) {
      errors['delivery.city'] = 'Please enter the city.';
    }
    if (input.state.trim().length < 2) {
      errors['delivery.state'] = 'Please enter the state.';
    }
  }

  const date = input.date.trim();
  if (!date) {
    errors['delivery.date'] = 'Please enter the delivery date.';
  } else if (!DATE_PATTERN.test(date)) {
    errors['delivery.date'] = 'Please use the format YYYY-MM-DD.';
  }

  if (input.notes.length > 500) {
    errors['delivery.notes'] = 'Please keep notes under 500 characters.';
  }

  return errors;
}

const styles = StyleSheet.create({
  section: {
    gap: Spacing.two,
    padding: Spacing.four,
    borderRadius: Spacing.three,
    borderWidth: 1,
    borderColor: '#EFE2F6',
    backgroundColor: Brand.white,
  },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: Brand.purpleDeep },
  sectionHint: { fontSize: 13, lineHeight: 18, color: Brand.notice },

  summaryRow: {
    gap: Spacing.one,
    paddingVertical: Spacing.two,
    borderBottomWidth: 1,
    borderBottomColor: '#F1E7F8',
  },
  summaryName: { fontSize: 15, fontWeight: '700', color: INPUT_INK },
  summaryMeta: { fontSize: 13, lineHeight: 18, color: INPUT_PLACEHOLDER },
  summaryLine: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.two,
  },
  summaryQty: { fontSize: 14, fontWeight: '700', color: Brand.purple },
  summaryTotal: { fontSize: 14, fontWeight: '700', color: Brand.purpleDeep },

  field: { gap: Spacing.one, marginTop: Spacing.three },
  label: { fontSize: 14, fontWeight: '700', color: Brand.purpleDeep },
  optional: { fontWeight: '500', color: Brand.notice },
  input: {
    minHeight: TouchTarget,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: Spacing.three,
    borderWidth: 1,
    borderColor: '#E3D6EC',
    backgroundColor: '#FBF8FE',
    fontSize: 15,
    color: INPUT_INK,
  },
  inputMultiline: { minHeight: 96, paddingTop: Spacing.two, textAlignVertical: 'top' },
  inputInvalid: { borderColor: Brand.pink },
  inputFocused: { borderColor: Brand.purple },
  fieldError: { fontSize: 13, color: INPUT_ERROR },

  methodRow: { flexDirection: 'row', gap: Spacing.two, marginTop: Spacing.two },
  methodChip: {
    flex: 1,
    minHeight: TouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.three,
    borderWidth: 1,
    borderColor: '#E3D6EC',
    backgroundColor: Brand.white,
  },
  methodChipActive: { borderColor: Brand.purple, backgroundColor: '#F6EDFB' },
  methodLabel: { fontSize: 15, fontWeight: '700', color: Brand.purpleDeep },
  methodLabelActive: { color: Brand.purple },

  submit: { marginTop: Spacing.two },
  submitDisabled: { opacity: 0.6 },

  successReference: {
    fontSize: 16,
    fontWeight: '700',
    color: Brand.purpleDeep,
    textAlign: 'center',
  },
});

type FieldProps = {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  error?: string;
  optional?: boolean;
  placeholder?: string;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words';
  autoComplete?: 'name' | 'email' | 'tel' | 'street-address' | 'off';
  multiline?: boolean;
};

/**
 * One labelled input with its validation message. The `error` key matches the
 * server's `fieldErrors` key, so a rejected request highlights the same field
 * this component already knows how to render.
 */
function Field({
  label,
  value,
  onChangeText,
  error,
  optional,
  placeholder,
  keyboardType = 'default',
  autoCapitalize = 'sentences',
  autoComplete = 'off',
  multiline,
}: FieldProps) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.field}>
      <Text style={styles.label}>
        {label}
        {optional ? <Text style={styles.optional}> (optional)</Text> : null}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={INPUT_PLACEHOLDER}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoComplete={autoComplete}
        multiline={multiline}
        accessibilityLabel={label}
        selectionColor={Brand.purple}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          styles.input,
          multiline && styles.inputMultiline,
          focused && styles.inputFocused,
          error && styles.inputInvalid,
        ]}
      />
      {error ? (
        <Text accessibilityRole="alert" style={styles.fieldError}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export default function CheckoutScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { session } = useAuth();
  const { lines, loading, total, itemCount, clear } = useCart();

  // Customer details.
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  // Defaults to pickup — the same default the website form uses — so address,
  // city and state stay optional until delivery is chosen.
  const [method, setMethod] = useState<DeliveryMethodId>('pickup');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [date, setDate] = useState('');
  const [notes, setNotes] = useState('');

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<SuccessState | null>(null);
  const [paying, setPaying] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [pendingOrder, setPendingOrder] = useState<PendingOrder | null>(null);

  const goBack = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace('/shop');
  }, []);

  /**
   * Freshest Supabase access token for website calls.
   *
   * The website links the order to the account only from a verified session —
   * never from a raw user id. Guests resolve to null and simply send no token.
   */
  const getAccessToken = useCallback(async (): Promise<string | null> => {
    let accessToken = session?.access_token ?? null;
    try {
      const { data } = (await getSupabaseClient()?.auth.getSession()) ?? {
        data: { session: null },
      };
      accessToken = data.session?.access_token ?? accessToken;
    } catch {
      // Fall back to the context session token (or guest) — a storage
      // hiccup must not block checkout.
    }
    return accessToken;
  }, [session]);

  /**
   * Confirms the order is PAID with the server and only then clears the cart.
   *
   * The database row is the single source of truth: the deep-link hint from
   * Paystack only chooses the failure wording, never the outcome. Returns true
   * when the cart was cleared and the success screen shown.
   */
  const verifyAndFinalize = useCallback(
    async (order: PendingOrder, hintReason: string | null): Promise<boolean> => {
      const accessToken = await getAccessToken();
      if (!accessToken) {
        setPaymentError(
          'Your session has expired. Please sign in again and try again.'
        );
        return false;
      }

      let payload: unknown = null;
      let isJson = false;
      let status = 0;
      try {
        const response = await fetch(paymentStatusUrl(order.orderId), {
          method: 'GET',
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        status = response.status;
        payload = await response.json();
        isJson = true;
      } catch {
        payload = null;
      }

      const body = (payload ?? {}) as {
        ok?: boolean;
        paid?: boolean;
        error?: string;
      };

      if (status === 401) {
        setPaymentError(
          'Your session has expired. Please sign in again and try again.'
        );
        return false;
      }

      if (!isJson || body.ok !== true) {
        setPaymentError(
          body.error ||
            "We couldn't confirm your payment just now. Check your connection and tap “Check payment status” to try again."
        );
        return false;
      }

      if (body.paid !== true) {
        setPaymentError(
          (hintReason && PAYMENT_HINT_MESSAGES[hintReason]) ||
            "That payment wasn't completed, so nothing has been charged. Your cart is unchanged."
        );
        return false;
      }

      // Server-confirmed PAID: the ONLY place the cart is cleared.
      try {
        await clear();
      } catch {
        // The order is paid server-side — a local clear failure must not hide
        // the confirmation. The cart context reports it instead.
      }
      setPendingOrder(null);
      setPaymentError(null);
      setSuccess({
        orderNumber: order.orderNumber,
        reference: order.reference,
        orderId: order.orderId,
        authorizationUrl: null,
      });
      return true;
    },
    [getAccessToken, clear]
  );

  /**
   * Opens Paystack for an already-created order and verifies afterwards.
   *
   * Cancelling or dismissing the browser leaves the cart untouched. This never
   * creates an order — it only continues the one `submit()` already made.
   */
  const payForOrder = useCallback(
    async (order: PendingOrder) => {
      if (paying) return;
      setPaymentError(null);
      setPaying(true);

      try {
        const browserResult = await openAuthSessionAsync(
          order.authorizationUrl,
          PAYMENT_RETURN_URL
        );

        if (browserResult.type !== 'success' || !browserResult.url) {
          setPaymentError(
            'Payment was not completed. Your cart is unchanged — you can try again when ready.'
          );
          return;
        }

        // Hint only: the failure reason suggested by the callback deep link.
        // Whether the cart clears is decided by the verify call below.
        let hintReason: string | null = null;
        try {
          hintReason = new URL(browserResult.url).searchParams.get('reason');
        } catch {
          hintReason = null;
        }

        await verifyAndFinalize(order, hintReason);
      } catch {
        setPaymentError(
          "We couldn't open the payment page. Check your connection and try again."
        );
      } finally {
        setPaying(false);
      }
    },
    [paying, verifyAndFinalize]
  );

  /** Re-checks the pending order without reopening Paystack. */
  const recheckPayment = useCallback(async () => {
    if (paying || !pendingOrder) return;
    setPaying(true);
    try {
      await verifyAndFinalize(pendingOrder, null);
    } finally {
      setPaying(false);
    }
  }, [paying, pendingOrder, verifyAndFinalize]);

  /**
   * Creates the order, then hands it to Paystack.
   *
   * Guarded by `submitting` at the very top, so a double tap can never fire a
   * second request while the first is still in flight. When an unpaid order
   * already exists for this cart, no second order is created — Paystack is
   * simply reopened for the existing one.
   */
  const submit = useCallback(async () => {
    if (submitting || paying) return;
    setSubmitError(null);

    if (lines.length === 0) {
      setSubmitError('Your cart is empty.');
      return;
    }

    const errors = validateForm({
      name,
      email,
      phone,
      method,
      address,
      city,
      state,
      date,
      notes,
    });
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      setSubmitError('Please check the highlighted details.');
      return;
    }

    // An unpaid order already exists — reopen Paystack for it instead of
    // creating a duplicate.
    if (pendingOrder) {
      await payForOrder(pendingOrder);
      return;
    }

    setSubmitting(true);

    try {
      const accessToken = await getAccessToken();

      const response = await fetch(CHECKOUT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({
          customer: {
            name: name.trim(),
            email: email.trim(),
            phone: phone.trim(),
          },
          delivery: {
            method,
            ...(method === 'delivery'
              ? {
                  address: address.trim(),
                  city: city.trim(),
                  state: state.trim(),
                }
              : {}),
            date: date.trim(),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          },
          // Only ids, quantities and free text — no price is ever sent.
          lines: lines.map(toCheckoutLine),
        }),
      });

      let payload: unknown = null;
      let isJson = false;
      try {
        payload = await response.json();
        isJson = true;
      } catch {
        // A non-JSON body (e.g. an HTML error page from a proxy or an
        // undeployed route) is a server-side problem, not a validation
        // rejection — it is surfaced with its own message below.
        payload = null;
      }

      const body = (payload ?? {}) as {
        ok?: boolean;
        error?: string;
        fieldErrors?: FieldErrors;
        authorizationUrl?: string;
        reference?: string;
        orderId?: string;
        orderNumber?: string;
      };

      if (!response.ok || !isJson || body.ok !== true) {
        // The server's field keys match ours, so a rejection lands on the
        // right input, and its `error` string is customer-safe by contract.
        if (body.fieldErrors && Object.keys(body.fieldErrors).length > 0) {
          setFieldErrors(body.fieldErrors);
        }
        setSubmitError(
          body.error ||
            (!isJson
              ? "The shop couldn't accept your order just now. Please try again in a few minutes."
              : "We couldn't start your order. Please try again.")
        );
        return;
      }

      if (!body.orderId || !body.authorizationUrl) {
        setSubmitError(
          "We couldn't start your payment. Please try again, or call us."
        );
        return;
      }

      const order: PendingOrder = {
        orderId: body.orderId,
        reference: body.reference ?? '',
        orderNumber: body.orderNumber ?? '',
        authorizationUrl: body.authorizationUrl,
      };

      if (__DEV__) {
        console.log('[checkout] order created', order.orderId);
      }

      // One order only from here on: the cart stays until the server confirms
      // PAID. Cancelling or failing Paystack never clears anything.
      setPendingOrder(order);
      await payForOrder(order);
    } catch {
      setSubmitError(
        "We couldn't reach the shop. Check your connection and try again."
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    submitting,
    paying,
    lines,
    name,
    email,
    phone,
    method,
    address,
    city,
    state,
    date,
    notes,
    pendingOrder,
    getAccessToken,
    payForOrder,
  ]);

  const requiresAddress = method === 'delivery';
  const padding = {
    paddingTop: insets.top + Spacing.two,
    paddingBottom: insets.bottom + BottomTabInset + Spacing.four,
  };

  if (success) {
    return (
      <View style={[cartStyles.screen, { backgroundColor: theme.background }]}>
        <ScrollView
          contentContainerStyle={[cartStyles.content, padding]}
          showsVerticalScrollIndicator={false}>
          <View style={cartStyles.inner}>
            <View style={cartStyles.stateBox}>
              <Text style={cartStyles.stateTitle}>Order received</Text>
              <Text style={cartStyles.stateText}>
                Thank you{name.trim() ? `, ${name.trim().split(' ')[0]}` : ''}.
                We&apos;ll confirm your order with you shortly.
              </Text>
              {success.orderNumber ? (
                <Text style={styles.successReference}>
                  Order {success.orderNumber}
                </Text>
              ) : null}
              {success.reference ? (
                <Text
                  style={[cartStyles.stateText, { color: theme.textSecondary }]}>
                  Reference: {success.reference}
                </Text>
              ) : null}
              <Pressable
                onPress={() => router.replace('/shop')}
                accessibilityRole="button"
                accessibilityLabel="Continue shopping"
                style={({ pressed }) => [
                  cartStyles.primaryButton,
                  pressed && cartStyles.pressed,
                ]}>
                <Text style={cartStyles.primaryText}>Continue shopping</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={[cartStyles.screen, { backgroundColor: theme.background }]}>
        <View style={cartStyles.stateBox}>
          <ActivityIndicator color={Brand.purple} />
          <Text style={[cartStyles.stateText, { color: theme.textSecondary }]}>
            Opening your cart…
          </Text>
        </View>
      </View>
    );
  }

  if (lines.length === 0) {
    return (
      <View style={[cartStyles.screen, { backgroundColor: theme.background }]}>
        <View style={cartStyles.stateBox}>
          <Text style={[cartStyles.stateTitle, { color: theme.text }]}>
            Your cart is empty
          </Text>
          <Text style={[cartStyles.stateText, { color: theme.textSecondary }]}>
            Add something delicious before checking out.
          </Text>
          <Pressable
            onPress={() => router.replace('/shop')}
            accessibilityRole="button"
            accessibilityLabel="Browse the shop"
            style={({ pressed }) => [
              cartStyles.primaryButton,
              pressed && cartStyles.pressed,
            ]}>
            <Text style={cartStyles.primaryText}>Browse the shop</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[cartStyles.screen, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={cartStyles.scrollView}
        contentContainerStyle={[cartStyles.content, padding]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <View style={cartStyles.inner}>
          <View style={cartStyles.header}>
            <Pressable
              onPress={goBack}
              accessibilityRole="button"
              accessibilityLabel="Back"
              hitSlop={Spacing.two}
              style={({ pressed }) => [
                cartStyles.backButton,
                pressed && cartStyles.pressed,
              ]}>
              <Text style={cartStyles.backText}>‹ Back</Text>
            </Pressable>
          </View>

          <Text style={[cartStyles.stateTitle, { color: theme.text }]}>
            Checkout ({itemCount} {itemCount === 1 ? 'item' : 'items'})
          </Text>

          {submitError ? (
            <Text accessibilityRole="alert" style={cartStyles.errorText}>
              {submitError}
            </Text>
          ) : null}

          {paying && !paymentError ? (
            <View
              accessibilityRole="alert"
              style={[styles.section, { marginTop: Spacing.three }]}>
              <ActivityIndicator color={Brand.purple} />
              <Text style={[styles.sectionHint, { textAlign: 'center' }]}>
                Waiting for Paystack… complete your payment in the browser, then
                return here to confirm your order.
              </Text>
            </View>
          ) : null}

          {paymentError && pendingOrder ? (
            <View style={[styles.section, { marginTop: Spacing.three }]}>
              <Text style={styles.sectionTitle}>Payment not completed</Text>
              <Text accessibilityRole="alert" style={styles.fieldError}>
                {paymentError}
              </Text>
              {pendingOrder.orderNumber ? (
                <Text style={styles.sectionHint}>
                  Order {pendingOrder.orderNumber} is waiting for payment — your
                  cart is unchanged.
                </Text>
              ) : null}
              <Pressable
                onPress={() => void payForOrder(pendingOrder)}
                disabled={paying}
                accessibilityRole="button"
                accessibilityLabel="Try payment again"
                style={({ pressed }) => [
                  cartStyles.primaryButton,
                  styles.submit,
                  paying && styles.submitDisabled,
                  pressed && cartStyles.pressed,
                ]}>
                {paying ? (
                  <ActivityIndicator color={Brand.white} />
                ) : (
                  <Text style={cartStyles.primaryText}>Try payment again</Text>
                )}
              </Pressable>
              <Pressable
                onPress={() => void recheckPayment()}
                disabled={paying}
                accessibilityRole="button"
                accessibilityLabel="Check payment status"
                hitSlop={Spacing.two}
                style={({ pressed }) => [
                  cartStyles.backButton,
                  { marginTop: Spacing.two },
                  pressed && cartStyles.pressed,
                ]}>
                <Text style={cartStyles.backText}>Check payment status</Text>
              </Pressable>
            </View>
          ) : null}

          {/* Display-only summary: the server re-prices every line itself. */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Your order</Text>
            {lines.map((line) => (
              <View key={line.id} style={styles.summaryRow}>
                <View style={styles.summaryLine}>
                  <Text style={styles.summaryName} numberOfLines={2}>
                    {line.productName}
                  </Text>
                  <Text style={styles.summaryTotal}>
                    {formatPrice(line.subtotal)}
                  </Text>
                </View>
                <Text style={styles.summaryMeta} numberOfLines={2}>
                  {line.quantity} × {formatPrice(line.unitPrice)}
                  {line.selections.length > 0
                    ? ` · ${line.selections.map(describeSelection).join(', ')}`
                    : ''}
                </Text>
                {line.inscription ? (
                  <Text style={styles.summaryMeta}>
                    Message: {line.inscription}
                  </Text>
                ) : null}
              </View>
            ))}
            <View style={cartStyles.totalRow}>
              <Text style={cartStyles.totalLabel}>Subtotal</Text>
              <Text style={cartStyles.totalValue}>{formatPrice(total)}</Text>
            </View>
            <Text style={styles.sectionHint}>
              Delivery is confirmed with you after your order is placed.
            </Text>
          </View>

          {/* Customer details. */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Your details</Text>

            <Field
              label="Full name"
              value={name}
              onChangeText={setName}
              placeholder="Ada Obi"
              autoCapitalize="words"
              autoComplete="name"
              error={fieldErrors['customer.name']}
            />
            <Field
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoComplete="email"
              error={fieldErrors['customer.email']}
            />
            <Field
              label="Phone number"
              value={phone}
              onChangeText={setPhone}
              placeholder="0801 234 5678"
              keyboardType="phone-pad"
              autoComplete="tel"
              error={fieldErrors['customer.phone']}
            />
          </View>

          {/* Delivery details. */}
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Delivery</Text>
            <Text style={styles.label}>Delivery method</Text>

            <View style={styles.methodRow}>
              {DELIVERY_METHODS.map((option) => {
                const active = option.id === method;
                return (
                  <Pressable
                    key={option.id}
                    onPress={() => setMethod(option.id)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={option.label}
                    style={({ pressed }) => [
                      styles.methodChip,
                      active && styles.methodChipActive,
                      pressed && cartStyles.pressed,
                    ]}>
                    <Text
                      style={[
                        styles.methodLabel,
                        active && styles.methodLabelActive,
                      ]}>
                      {option.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            {fieldErrors['delivery.method'] ? (
              <Text
                accessibilityRole="alert"
                style={[styles.fieldError, { marginTop: Spacing.one }]}>
                {fieldErrors['delivery.method']}
              </Text>
            ) : null}

            {requiresAddress ? (
              <>
                <Field
                  label="Address"
                  value={address}
                  onChangeText={setAddress}
                  placeholder="Street and building"
                  autoComplete="street-address"
                  error={fieldErrors['delivery.address']}
                />
                <Field
                  label="City"
                  value={city}
                  onChangeText={setCity}
                  placeholder="Lagos"
                  error={fieldErrors['delivery.city']}
                />
                <Field
                  label="State"
                  value={state}
                  onChangeText={setState}
                  placeholder="Lagos"
                  error={fieldErrors['delivery.state']}
                />
              </>
            ) : (
              <Text style={[styles.sectionHint, { marginTop: Spacing.two }]}>
                Collect your order from 60 Adeboye St, Somolu, Ilaje/Akoka
                100001, Lagos, Nigeria.
              </Text>
            )}

            <Field
              label={requiresAddress ? 'Delivery date' : 'Pickup date'}
              value={date}
              onChangeText={setDate}
              placeholder="YYYY-MM-DD"
              error={fieldErrors['delivery.date']}
            />
            <Field
              label="Notes"
              value={notes}
              onChangeText={setNotes}
              placeholder="Allergies, colour preferences, delivery window…"
              optional
              multiline
              error={fieldErrors['delivery.notes']}
            />
          </View>

          <Pressable
            onPress={() => void submit()}
            disabled={submitting || paying}
            accessibilityRole="button"
            accessibilityLabel={pendingOrder ? 'Continue to payment' : 'Place order'}
            style={({ pressed }) => [
              cartStyles.primaryButton,
              styles.submit,
              (submitting || paying) && styles.submitDisabled,
              pressed && cartStyles.pressed,
            ]}>
            {submitting || paying ? (
              <ActivityIndicator color={Brand.white} />
            ) : (
              <Text style={cartStyles.primaryText}>
                {pendingOrder ? 'Continue to payment' : 'Place order'}
              </Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
