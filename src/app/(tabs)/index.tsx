import type { User } from '@supabase/supabase-js';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useAuth } from '@/hooks/use-auth';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useTheme } from '@/hooks/use-theme';
import { resolveImageUrl } from '@/lib/supabase/images';

/**
 * De Mols Cakes brand palette, kept local until it is rolled out app-wide.
 */
const Brand = {
  purple: '#7000AD',
  purpleDeep: '#4E007C',
  pink: '#FF0B6B',
  white: '#FFFFFF',
} as const;

/** Categories are tinted along a purple -> pink ramp for a cohesive look. */
const CATEGORIES = [
  { name: 'Cakes', accent: '#7000AD' },
  { name: 'Cupcakes', accent: '#8E1BA8' },
  { name: 'Parfaits', accent: '#C23A86' },
  { name: 'Yogurt', accent: '#E8476F' },
  { name: 'Wedding Cakes', accent: '#FF0B6B' },
] as const;

/**
 * Website photography, resolved against the deployed site's origin so the app
 * shows De Mols Cakes' real images without copying files into the bundle.
 *
 * The brand mark is the exception: it is bundled (`assets/images/logo.png`,
 * byte-identical to the website's `public/logo-optimized.png`) and loaded
 * with `require()` like every other brand asset, so the header never depends
 * on a network fetch to show the logo.
 */
const HERO_IMAGE = '/products/hero-wedding-cake.jpg';

/** Occasions mirror the website's `src/lib/occasions.ts` — navigation only. */
const OCCASIONS = [
  { name: 'Birthday', blurb: 'A cake to hold the candles, plus cupcakes for the table.' },
  { name: 'Anniversary', blurb: 'Something layered and a little bit special.' },
  { name: 'Graduation', blurb: 'Cakes and cupcakes for the village that came to celebrate.' },
  { name: 'A Little Something', blurb: 'Parfaits and yogurt for no reason at all.' },
] as const;

/** Real De Mols Cakes photography (`/products/...`) shown on the home screen. */
const FEATURED = [
  { name: 'Celebration cakes', image: '/products/cake-size-8.jpg' },
  { name: 'Wedding cakes', image: '/products/wedding-cake.jpg' },
  { name: 'Parfaits', image: '/products/cake-parfait.jpg' },
  { name: 'Yogurt', image: '/products/yogurt.jpg' },
  { name: 'Bento & cupcakes', image: '/products/bento-5-cupcakes-combo.jpg' },
] as const;

/** Minimum comfortable touch target on both platforms. */
const TouchTarget = 48;

/**
 * Short, human-friendly name for the signed-in account.
 *
 * Supabase user metadata is untyped and optional, so every field is treated as
 * possibly missing: full name first, then the local part of the email, and only
 * then a neutral fallback. Never returns an empty string.
 */
function displayNameFor(user: User | null): string {
  const metadata = user?.user_metadata as Record<string, unknown> | undefined;

  const fullName = [metadata?.full_name, metadata?.name]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (fullName) return fullName;

  const email = typeof user?.email === 'string' ? user.email.trim() : '';
  if (email) {
    const localPart = email.split('@')[0]?.trim();
    if (localPart) return localPart;
  }

  return 'My account';
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const isDark = useColorScheme() === 'dark';
  const [showCartNotice, setShowCartNotice] = useState(false);

  // The provider owns the session; the header simply reflects it, so a sign-in
  // or sign-out anywhere updates this screen immediately.
  const { user, loading: authLoading, signOut } = useAuth();
  const accountName = displayNameFor(user);
  const isSignedIn = Boolean(user);

  const cardBackground = isDark ? '#26103A' : '#F6EDFB';
  const cardBorder = isDark ? '#3D1C59' : '#EFE2F6';

  // Resolves against the deployed website (with a production fallback), so
  // the imagery renders on a physical device with no local env file.
  const heroUri = resolveImageUrl(HERO_IMAGE);

  return (
    <ScrollView
      style={styles.scrollView}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + Spacing.two, backgroundColor: theme.background },
      ]}
      showsVerticalScrollIndicator={false}>
      <View style={styles.inner}>
        {/* Header */}
        <View style={styles.header}>
          <View style={styles.brand}>
            <Image
              source={require('@/assets/images/logo.png')}
              style={styles.brandLogo}
              contentFit="contain"
              transition={200}
              accessibilityLabel="De Mols Cakes"
            />
          </View>

          {isSignedIn ? (
            <Pressable
              onPress={() => void signOut()}
              disabled={authLoading}
              accessibilityRole="button"
              accessibilityLabel={`Sign out of ${accountName}`}
              accessibilityHint="Signs you out of your De Mols Cakes account"
              hitSlop={Spacing.two}
              style={({ pressed }) => [
                styles.signInButton,
                { borderColor: cardBorder },
                pressed && styles.pressed,
              ]}>
              <Text style={[styles.signInText, { color: Brand.purple }]} numberOfLines={1}>
                Sign out
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => router.push('/login')}
              accessibilityRole="button"
              accessibilityLabel="Sign in"
              accessibilityHint="Opens your De Mols Cakes account"
              hitSlop={Spacing.two}
              style={({ pressed }) => [
                styles.signInButton,
                { borderColor: cardBorder },
                pressed && styles.pressed,
              ]}>
              <Text style={[styles.signInText, { color: Brand.purple }]}>Sign in</Text>
            </Pressable>
          )}
        </View>

        {/* Hero */}
        <Animated.View entering={FadeInDown.duration(320)} style={styles.hero}>
          <View pointerEvents="none" style={styles.heroGlow} />

          <Text style={styles.heroEyebrow}>DE MOLS CAKES · LAGOS</Text>
          <Text style={styles.heroTitle}>MAKE EVERY MOMENT SWEETER.</Text>
          <Text style={styles.heroBody}>
            Cakes, cupcakes, naked cakes, parfaits and yogurt made by De Mols Cakes — for the
            celebrations, the surprises, and the ordinary Tuesday that could use something sweet.
          </Text>

          <View style={styles.heroActions}>
            <Pressable
              onPress={() => router.push('/shop')}
              accessibilityRole="button"
              accessibilityLabel="Shop Cakes"
              accessibilityHint="Opens the cake catalogue"
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressedLight]}>
              <Text style={styles.primaryButtonText}>Shop Cakes</Text>
            </Pressable>

            <Pressable
              onPress={() => router.push('/cart')}
              accessibilityRole="button"
              accessibilityLabel="View Cart"
              accessibilityHint="Shows what is in your cart"
              style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressedLight]}>
              <Text style={styles.secondaryButtonText}>View Cart</Text>
            </Pressable>
          </View>
        </Animated.View>

        {/* Hero photography — the website's real work. */}
        <Animated.View entering={FadeInDown.delay(80).duration(320)} style={styles.heroMedia}>
          {heroUri ? (
            <Image
              source={{ uri: heroUri }}
              style={styles.heroImage}
              contentFit="cover"
              transition={200}
              accessibilityLabel="White and gold celebration cake made by De Mols Cakes"
            />
          ) : null}
          <View style={styles.heroCaption}>
            <Text style={styles.heroCaptionEyebrow}>SIX THINGS WE MAKE</Text>
            <Text style={styles.heroCaptionText}>
              Wedding Cakes · Cakes · Naked Cakes · Cupcakes · Parfaits · Yogurt
            </Text>
          </View>
        </Animated.View>

        {/* Occasions */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>What are we celebrating?</Text>
          <Text style={[styles.sectionSubtitle, { color: theme.textSecondary }]}>
            Pick the moment and we&apos;ll take you straight to the menu that fits.
          </Text>

          <View style={styles.occasionGrid}>
            {OCCASIONS.map((occasion, index) => (
              <Pressable
                key={occasion.name}
                onPress={() => router.push('/shop')}
                accessibilityRole="button"
                accessibilityLabel={`Shop for ${occasion.name}`}
                accessibilityHint="Opens the cake catalogue"
                style={({ pressed }) => [
                  styles.occasionCard,
                  { backgroundColor: cardBackground, borderColor: cardBorder },
                  pressed && styles.pressed,
                ]}>
                <Text style={styles.occasionIndex}>{String(index + 1).padStart(2, '0')}</Text>
                <Text style={[styles.occasionName, { color: theme.text }]}>{occasion.name}</Text>
                <Text style={[styles.occasionBlurb, { color: theme.textSecondary }]}>
                  {occasion.blurb}
                </Text>
                <Text style={styles.occasionCta}>Shop this →</Text>
              </Pressable>
            ))}
          </View>
        </View>

        {/* Categories */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Browse by category</Text>
          <Text style={[styles.sectionSubtitle, { color: theme.textSecondary }]}>
            Find the perfect bake for your occasion.
          </Text>

          <View style={styles.categoryGrid}>
            {CATEGORIES.map((category) => (
              <Pressable
                key={category.name}
                onPress={() => router.push('/shop')}
                accessibilityRole="button"
                accessibilityLabel={`Browse ${category.name}`}
                style={({ pressed }) => [
                  styles.categoryCard,
                  { backgroundColor: cardBackground, borderColor: cardBorder },
                  pressed && styles.pressed,
                ]}>
                <View style={[styles.categorySwatch, { backgroundColor: category.accent }]} />
                <Text style={[styles.categoryName, { color: theme.text }]} numberOfLines={1}>
                  {category.name}
                </Text>
                <SymbolView
                  name={{ ios: 'chevron.right', android: 'chevron_right', web: 'chevron_right' }}
                  size={12}
                  weight="bold"
                  tintColor={theme.textSecondary}
                />
              </Pressable>
            ))}
          </View>
        </View>

        {/* Fresh from the kitchen */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Fresh from the kitchen</Text>
          <Text style={[styles.sectionSubtitle, { color: theme.textSecondary }]}>
            Real De Mols Cakes photography — what you see is what we bake.
          </Text>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.featuredRow}>
            {FEATURED.map((item) => {
              const uri = resolveImageUrl(item.image);
              return (
                <Pressable
                  key={item.name}
                  onPress={() => router.push('/shop')}
                  accessibilityRole="button"
                  accessibilityLabel={`Browse ${item.name}`}
                  accessibilityHint="Opens the cake catalogue"
                  style={({ pressed }) => [
                    styles.featuredCard,
                    { backgroundColor: cardBackground, borderColor: cardBorder },
                    pressed && styles.pressed,
                  ]}>
                  {uri ? (
                    <Image
                      source={{ uri }}
                      style={styles.featuredImage}
                      contentFit="cover"
                      transition={200}
                      accessibilityLabel={item.name}
                    />
                  ) : (
                    <View style={[styles.featuredImage, { backgroundColor: cardBorder }]} />
                  )}
                  <Text
                    style={[styles.featuredName, { color: theme.text }]}
                    numberOfLines={1}>
                    {item.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>

        </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scrollView: {
    flex: 1,
  },
  content: {
    // Clear the native tab bar so the last card is never hidden behind it.
    paddingBottom: BottomTabInset + Spacing.four,
  },
  inner: {
    width: '100%',
    maxWidth: MaxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: Spacing.four,
    gap: Spacing.four,
  },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.three,
    minHeight: TouchTarget,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexShrink: 1,
  },
  signInButton: {
    minHeight: TouchTarget - 8,
    paddingHorizontal: Spacing.three,
    justifyContent: 'center',
    borderRadius: Spacing.five,
    borderWidth: 1,
  },
  signInText: {
    fontSize: 15,
    fontWeight: '700',
  },

  // Hero
  hero: {
    backgroundColor: Brand.purple,
    borderRadius: Spacing.five,
    padding: Spacing.four,
    gap: Spacing.two,
    overflow: 'hidden',
  },
  heroGlow: {
    position: 'absolute',
    top: -60,
    right: -40,
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: Brand.pink,
    opacity: 0.28,
  },
  heroEyebrow: {
    color: Brand.pink,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.6,
  },
  heroTitle: {
    color: Brand.white,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    marginTop: Spacing.half,
  },
  heroBody: {
    color: '#F0E4F7',
    fontSize: 16,
    lineHeight: 24,
  },
  heroActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  primaryButton: {
    flexGrow: 1,
    flexBasis: 140,
    minHeight: TouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Brand.pink,
    borderRadius: Spacing.four,
    paddingHorizontal: Spacing.three,
  },
  primaryButtonText: {
    color: Brand.white,
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    flexGrow: 1,
    flexBasis: 140,
    minHeight: TouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Spacing.four,
    paddingHorizontal: Spacing.three,
    borderWidth: 1,
    borderColor: '#C9A6E8',
  },
  secondaryButtonText: {
    color: Brand.white,
    fontSize: 16,
    fontWeight: '700',
  },

  // Categories
  section: {
    gap: Spacing.half,
  },
  sectionTitle: {
    color: Brand.purpleDeep,
    fontSize: 20,
    fontWeight: '700',
  },
  sectionSubtitle: {
    fontSize: 15,
    lineHeight: 21,
    marginBottom: Spacing.two,
  },
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  categoryCard: {
    flexGrow: 1,
    flexBasis: 150,
    minHeight: TouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    paddingHorizontal: Spacing.three,
    borderRadius: Spacing.three,
    borderWidth: 1,
  },
  categorySwatch: {
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  categoryName: {
    flexShrink: 1,
    fontSize: 16,
    fontWeight: '600',
  },
  brandLogo: {
    width: 126,
    height: 42,
  },

  // Hero photography
  heroMedia: {
    borderRadius: Spacing.four,
    borderWidth: 1,
    borderColor: '#EFE2F6',
    backgroundColor: Brand.white,
    overflow: 'hidden',
  },
  heroImage: {
    width: '100%',
    aspectRatio: 4 / 3,
  },
  heroCaption: {
    gap: Spacing.half,
    padding: Spacing.three,
  },
  heroCaptionEyebrow: {
    color: Brand.purple,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.4,
  },
  heroCaptionText: {
    color: '#241233',
    fontSize: 16,
    lineHeight: 22,
    fontWeight: '600',
  },

  // Occasions
  occasionGrid: {
    gap: Spacing.two,
  },
  occasionCard: {
    gap: Spacing.half,
    padding: Spacing.three,
    borderRadius: Spacing.three,
    borderWidth: 1,
  },
  occasionIndex: {
    color: Brand.pink,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  occasionName: {
    fontSize: 18,
    fontWeight: '700',
  },
  occasionBlurb: {
    fontSize: 14,
    lineHeight: 20,
  },
  occasionCta: {
    marginTop: Spacing.one,
    color: Brand.purple,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },

  // Fresh from the kitchen
  featuredRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingRight: Spacing.four,
  },
  featuredCard: {
    width: 150,
    gap: Spacing.one,
    padding: Spacing.one,
    borderRadius: Spacing.three,
    borderWidth: 1,
  },
  featuredImage: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: Spacing.two,
  },
  featuredName: {
    fontSize: 14,
    fontWeight: '600',
    paddingHorizontal: Spacing.half,
    paddingBottom: Spacing.half,
  },

  // Cart notice
  notice: {
    gap: Spacing.half,
    padding: Spacing.three,
    borderRadius: Spacing.three,
    borderWidth: 1,
  },
  noticeTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  noticeBody: {
    fontSize: 15,
    lineHeight: 21,
  },
  noticeDismiss: {
    alignSelf: 'flex-start',
    minHeight: TouchTarget - 12,
    justifyContent: 'center',
  },
  noticeDismissText: {
    fontSize: 15,
    fontWeight: '700',
  },

  // Shared press feedback
  pressed: {
    opacity: 0.7,
  },
  pressedLight: {
    opacity: 0.8,
  },
});
