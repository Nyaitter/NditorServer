import PropTypes from 'prop-types';
import React from 'react';
import classNames from 'classnames';

import DragConstants from '../../lib/drag-constants';

import Box from '../box/box.jsx';
import SpriteSelectorItem from '../../containers/sprite-selector-item.jsx';
import SortableHOC from '../../lib/sortable-hoc.jsx';
import SortableAsset from '../asset-panel/sortable-asset.jsx';
import ThrottledPropertyHOC from '../../lib/throttled-property-hoc.jsx';

import styles from './sprite-selector.css';

const ThrottledSpriteSelectorItem = ThrottledPropertyHOC('asset', 500)(SpriteSelectorItem);

class SpriteList extends React.Component {
    shouldComponentUpdate (nextProps) {
        const previousKeys = Object.keys(this.props).filter(key => key !== 'items' && key !== 'dragInfo');
        const nextKeys = Object.keys(nextProps).filter(key => key !== 'items' && key !== 'dragInfo');
        if (previousKeys.length !== nextKeys.length || previousKeys.some(key =>
            !Object.prototype.hasOwnProperty.call(nextProps, key) || this.props[key] !== nextProps[key])) {
            return true;
        }
        if (!this.spriteViews || this.spriteViews.length !== nextProps.items.length) return true;
        for (let i = 0; i < nextProps.items.length; i++) {
            const sprite = nextProps.items[i];
            const view = this.spriteViews[i];
            const asset = sprite.costume && sprite.costume.asset;
            if (view.id !== sprite.id || view.name !== sprite.name || view.asset !== asset) {
                return true;
            }
        }
        return false;
    }
    render () {
        const props = this.props;
        // The VM changes costume objects in place, so keep the displayed asset reference.
        this.spriteViews = props.items.map(sprite => ({
            id: sprite.id, name: sprite.name, asset: sprite.costume && sprite.costume.asset
        }));
        const {
            containerRef,
            editingTarget,
            draggingIndex,
            draggingType,
            hoveredTarget,
            onDeleteSprite,
            onDuplicateSprite,
            onExportSprite,
            onSelectSprite,
            onAddSortable,
            onRemoveSortable,
            ordering,
            orderingPositions,
            raised,
            selectedId,
            items
        } = props;

        const isSpriteDrag = draggingType === DragConstants.SPRITE;
        const isAssetDrag = draggingType === DragConstants.COSTUME ||
            draggingType === DragConstants.SOUND ||
            draggingType === DragConstants.BACKPACK_COSTUME ||
            draggingType === DragConstants.BACKPACK_SOUND ||
            draggingType === DragConstants.BACKPACK_CODE;
        // Resolve indices once per drag render instead of scanning ordering for every sprite.
        const dragPositions = isSpriteDrag && !orderingPositions && ordering ?
            ordering.reduce((positions, itemIndex, position) => {
                positions[itemIndex] = position;
                return positions;
            }, []) : null;

        return (
            <Box
                className={classNames(styles.scrollWrapper, {
                    [styles.scrollWrapperDragging]: draggingType === DragConstants.BACKPACK_SPRITE
                })}
                componentRef={containerRef}
            >
                <Box
                    className={styles.itemsWrapper}
                >
                    {items.map((sprite, index) => {

                        // If the sprite has just received a block drop, used for green highlight
                        const receivedBlocks = (
                            hoveredTarget.sprite === sprite.id &&
                    sprite.id !== editingTarget &&
                    hoveredTarget.receivedBlocks
                        );

                        // If the sprite is indicating it can receive block dropping, used for blue highlight
                        let isRaised = !receivedBlocks && raised && sprite.id !== editingTarget;

                        // A sprite is also raised if a costume or sound is being dragged.
                        // Note the absence of the self-sharing check: a sprite can share assets with itself.
                        // This is a quirk of 2.0, but seems worth leaving possible, it
                        // allows quick (albeit unusual) duplication of assets.
                        isRaised = isRaised || isAssetDrag;

                        return (
                            <SortableAsset
                                className={classNames(styles.spriteWrapper, {
                                    [styles.placeholder]: isSpriteDrag && index === draggingIndex})}
                                index={isSpriteDrag ?
                                    (orderingPositions ? orderingPositions[index] :
                                        (dragPositions && index in dragPositions ? dragPositions[index] : -1)) :
                                    index}
                                key={sprite.id || sprite.name}
                                onAddSortable={onAddSortable}
                                onRemoveSortable={onRemoveSortable}
                            >
                                <ThrottledSpriteSelectorItem
                                    asset={sprite.costume && sprite.costume.asset}
                                    className={classNames(styles.sprite, {
                                        [styles.raised]: isRaised,
                                        [styles.receivedBlocks]: receivedBlocks
                                    })}
                                    dragPayload={sprite.id}
                                    dragType={DragConstants.SPRITE}
                                    id={sprite.id}
                                    index={index}
                                    key={sprite.id}
                                    name={sprite.name}
                                    selected={sprite.id === selectedId}
                                    onClick={onSelectSprite}
                                    onDeleteButtonClick={onDeleteSprite}
                                    onDuplicateButtonClick={onDuplicateSprite}
                                    onExportButtonClick={onExportSprite}
                                />
                            </SortableAsset>
                        );
                    })}
                </Box>
            </Box>
        );
    }
}

SpriteList.propTypes = {
    containerRef: PropTypes.func,
    draggingIndex: PropTypes.number,
    draggingType: PropTypes.oneOf(Object.keys(DragConstants)),
    editingTarget: PropTypes.string,
    hoveredTarget: PropTypes.shape({
        hoveredSprite: PropTypes.string,
        receivedBlocks: PropTypes.bool,
        sprite: PropTypes.string
    }),
    // Compared through the generic prop check so legacy locale context reaches the tiles.
    // eslint-disable-next-line react/no-unused-prop-types
    intl: PropTypes.object,
    // eslint-disable-next-line react/no-unused-prop-types
    locale: PropTypes.string,
    items: PropTypes.arrayOf(PropTypes.shape({
        id: PropTypes.string,
        costume: PropTypes.shape({
            asset: PropTypes.object,
            url: PropTypes.string,
            name: PropTypes.string.isRequired,
            bitmapResolution: PropTypes.number.isRequired,
            rotationCenterX: PropTypes.number.isRequired,
            rotationCenterY: PropTypes.number.isRequired
        }),
        name: PropTypes.any, // modified by folders addon
        order: PropTypes.number.isRequired
    })),
    onAddSortable: PropTypes.func,
    onDeleteSprite: PropTypes.func,
    onDuplicateSprite: PropTypes.func,
    onExportSprite: PropTypes.func,
    onRemoveSortable: PropTypes.func,
    onSelectSprite: PropTypes.func,
    ordering: PropTypes.arrayOf(PropTypes.number),
    orderingPositions: PropTypes.arrayOf(PropTypes.number),
    raised: PropTypes.bool,
    selectedId: PropTypes.string
};

export default SortableHOC(SpriteList);
